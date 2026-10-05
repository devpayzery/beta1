// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IVynarTransferWithAuthorization {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external returns (bool);
}

interface IStakingNotify {
    function notifyRewardVynar(uint256 amount) external;
}

/**
 * @title BoosterVault
 * @notice Cobra boosters en VYNAR por EIP-3009 y reparte lo cobrado entre los
 *         stakers y la tesoreria. No mintea, no guarda derechos de juego y no
 *         toca ArcadeVaultV6: el unico efecto de un booster es que el servidor
 *         pase un total de VYNAR mayor a `mintForScoreOnce`.
 * @dev Compilado con solc 0.8.24, evmVersion cancun, optimizer 200 runs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUE ESTE CONTRATO EXISTE Y NO UN ERC20 DE BOOSTERS
 *
 * El booster no es un token que el jugador guarda: es una UNIDAD, y lo que se
 * gasta es el derecho a una ventana de 2x dentro de una partida de 20 a 30
 * segundos. Emitir un token transferible significaria que el jugador puede
 * venderlo, regalarlo o guardarlo indefinidamente, y el precio se fijaria en un
 * mercado secundario que este contrato no puede vigilar. Cobrando por compra y
 * guardando una fila por unidad, el saldo es exactamente "cuantas ventanas has
 * comprado", que es lo unico que `boosterValidationError` necesita comprobar.
 *
 * El cobro es EIP-3009 (`transferWithAuthorization`), no una allowance. La razon
 * esta en la pantalla del jugador: para esto no hay una transaccion que el
 * jugador firme antes de comprar, hay una respuesta HTTP 402 con un desafio que
 * firma en el momento. Una allowance exigiria una tx previa, y con ella un paso
 * mas entre "quiero el booster" y "tengo el booster".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LOS TRES SALDOS, Y POR QUE NO SE PUEDEN COMMINGLEAR
 *
 * Son tres porque tienen tres destinos y tres permisos distintos. Juntarlos en
 * un unico saldo "balance" obligaria a que cada retirada comprobase de donde
 * viene el dinero, y eso es exactamente el tipo de comprobacion que se olvida
 * una vez y drena los fondos de los stakers.
 *
 *   1. `unsettledVynar`. Dinero cobrado cuya fila de `arcade_booster_units`
 *      todavia NO esta confirmada en la base de datos. Existe porque el cobro
 *      on-chain y la escritura en Postgres no son atomicos: si la tx entra y
 *      el INSERT falla, hay VYNAR de un jugador al que no se le concedio ninguna
 *      unidad. Con este saldo separado, ese dinero es reembolsable al jugador y
 *      no puede terminar en el reparto. Es el saldo que justifica el contrato.
 *
 *   2. `stakingRewards`. Parte del cobro que ya esta liquidada y es de los
 *      stakers. Sale por `routeToStaking`, que llama a
 *      `StakingVault.notifyRewardVynar` y por eso necesita allowance y que el
 *      StakingVault tenga a este contrato como `owner`.
 *
 *   3. `treasuryBalance`. La parte que se queda el protocolo. Sale por
 *      `withdrawTreasury`, con un plazo mas largo que el de los stakers porque
 *      es el unico saldo que el owner puede querer para si mismo.
 *
 * Los tres se contabilizan en VYNAR, que es el unico token que entra aqui.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LO QUE ESTE CONTRATO NO HACE, Y ES UNA DECISION
 *
 * No hay `rescue`. StakingVault si lo tiene, y aqui no, a proposito: los fondos
 * de `unsettledVynar` son de un jugador concreto y los de `stakingRewards` son
 * de los stakers, asi que una funcion de rescate que los barriera seria
 * ownershipless en la practica. Si el VYNAR se mandara a la direccion equivocada
 * por un error de despliegue, la salida es un despliegue nuevo, no un rescate.
 *
 * Tampoco guarda la lista de arenas con las que se puede comprar ni el
 * multiplicador: esas dos cosas viven en `lib/arcade-arenas.ts`, que es la
 * unica fuente de verdad del juego. Este contrato solo necesita saber que arenas
 * son jugables, y para eso esta `playableArenas()`.
 */
contract BoosterVault is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable vynar;
    IVynarTransferWithAuthorization public immutable vynarEip3009;
    IStakingNotify public immutable stakingVault;

    /// @notice VYNAR por unidad. El cliente NO declara el importe: se calcula aqui
    ///         desde esta constante, asi que no existe forma de pagar de menos.
    /// @dev 25 VYNAR. Es el precio de una ventana de 2x sobre una partida que da
    ///      hasta 28800 puntos en `hard`, o sea hasta 57600 puntos de VYNAR.
    uint256 public constant UNIT_PRICE_VYNAR = 25e18;

    uint256 public constant BASIS = 10_000;

    /// @notice Reparto de lo cobrado. La suma tiene que ser BASIS y `setSplit`
    ///         lo comprueba, porque los dos numeros se mueven por separado.
    /// @dev 70/30. No es una convencion: `STAKING_BPS` es lo que decide cuanto
    ///      de lo que pagan los jugadores por 2x vuelve a ellos como rendimiento.
    uint256 public constant STAKING_BPS = 7_000;
    uint256 public constant TREASURY_BPS = 3_000;

    /// @notice Plazo para liquidar una compra o devolverla.
    /// @dev Pasados 2h sin liquidar, el dinero es del jugador y `refundPurchase`
    ///      lo devuelve. Que el plazo sea el del `refundPurchase` y no el del
    ///      `settlePurchase` es lo que hace que un servidor caido sea un
    ///      contratiempo y no una perdida de fondos: el jugador recupera su VYNAR
    ///      sin que nadie tenga que intervenir.
    uint256 public constant SETTLE_WINDOW = 2 hours;

    /// @notice Espera antes de mover saldo a los stakers.
    /// @dev Aplica al saldo COMPLETO, no a la diferencia. Envejece las recompensas
    ///      de forma uniforme mientras el vault este parado, y erra hacia lo
    ///      seguro: lo que se retrasa es el reparto, nunca el cobro.
    uint256 public constant ROUTING_DELAY = 24 hours;

    /// @notice Espera antes de retirar a tesoreria. Mas largo que el de los
    ///         stakers porque es el unico saldo que el owner puede querer para si.
    uint256 public constant TREASURY_DELAY = 7 days;

    /// @notice Tope de unidades por compra, para que el fallo de la escritura en
    ///         la base de datos no deje una sola compra con un saldo enorme sin
    ///         liquidar.
    uint256 public constant MAX_UNITS_PER_PURCHASE = 5;

    struct Purchase {
        address player;
        uint256 units;
        uint256 amount;
        uint256 purchasedAt;
        uint256 settledAt; // 0 mientras siga pendiente de liquidar
        bool refunded;
    }

    /// @notice Compras por id. El id lo deriva quien llama y ya no se puede
    ///         reutilizar, porque el nonce de EIP-3009 es de un solo uso.
    mapping(bytes32 => Purchase) public purchases;

    mapping(address => uint256) public unsettledOf;
    uint256 public unsettledVynar;
    uint256 public stakingRewards;
    uint256 public treasuryBalance;
    uint256 public stakingAccruedAt;
    uint256 public treasuryAccruedAt;
    uint256 public totalUnitsSold;

    /// @dev AGENT (3) esta reservada y no se vende, igual que en `parseArenaParam`.
    ///      Esta funcion es el UNICO sitio del contrato que decide que arenas
    ///      existen, para que anadir un modo no obligue a tocar tres `require`.
    function playableArenas() public pure returns (uint8[] memory arenas) {
        arenas = new uint8[](3);
        arenas[0] = 0; // HUMAN
        arenas[1] = 1; // MEDIUM
        arenas[2] = 2; // HARD
    }

    constructor(address vynarToken_, address stakingVault_, address initialOwner) Ownable(initialOwner) {
        require(vynarToken_ != address(0), "INVALID_TOKEN");
        require(stakingVault_ != address(0), "INVALID_STAKING_VAULT");
        vynar = IERC20(vynarToken_);
        vynarEip3009 = IVynarTransferWithAuthorization(vynarToken_);
        stakingVault = IStakingNotify(stakingVault_);
    }

    /**
     * @notice Compra booster. El jugador firma una autorizacion EIP-3009 y
     *         cualquiera la reenvia; el importe lo calcula este contrato.
     * @dev Que lo llame cualquiera es intencionado: la firma es la que autoriza
     *      el gasto y el nonce impide repetirla, asi que la funcion no tiene
     *      ningun criterio de "quien puede comprar", solo de "que compra".
     *
     *      El dinero entra en `unsettledVynar` y NO se reparte todavia. El reparto
     *      ocurre en `settlePurchase`, despues de que la base de datos haya
     *      confirmado la unidad. Adelantarlo seria repartir VYNAR de compras que
     *      quiza se devuelven.
     */
    function collectPurchase(
        uint8 arena,
        uint256 units,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external nonReentrant {
        require(_isPlayable(arena), "ARENA_NOT_PLAYABLE");
        require(units > 0 && units <= MAX_UNITS_PER_PURCHASE, "INVALID_UNITS");

        uint256 amount = UNIT_PRICE_VYNAR * units;
        bytes32 purchaseId = keccak256(abi.encode(block.chainid, address(this), msg.sender, arena, nonce));

        Purchase storage purchase = purchases[purchaseId];
        require(purchase.purchasedAt == 0, "PURCHASE_EXISTS");

        // EIP-3009 devuelve `true` o revierte. Un `false` sin revertir seria un
        // cobro que no cobro, asi que se comprueba.
        bool ok = vynarEip3009.transferWithAuthorization(
            msg.sender,
            address(this),
            amount,
            validAfter,
            validBefore,
            nonce,
            signature
        );
        require(ok, "TRANSFER_FAILED");

        purchase.player = msg.sender;
        purchase.units = units;
        purchase.amount = amount;
        purchase.purchasedAt = block.timestamp;

        unsettledOf[msg.sender] += amount;
        unsettledVynar += amount;
        totalUnitsSold += units;

        emit PurchaseCollected(purchaseId, msg.sender, arena, units, amount);
    }

    /**
     * @notice Confirma la compra y reparte el importe entre stakers y tesoreria.
     * @dev Solo el owner, y solo dentro de `SETTLE_WINDOW`. Pasado el plazo la
     *      compra se devuelve al jugador: es preferible devolver VYNAR a
     *      liquidar un dia tarde una compra cuya fila en la base de datos quizas
     *      nunca existio.
     */
    function settlePurchase(bytes32 purchaseId) external onlyOwner nonReentrant {
        Purchase storage purchase = purchases[purchaseId];
        require(purchase.purchasedAt != 0, "PURCHASE_UNKNOWN");
        require(purchase.settledAt == 0 && !purchase.refunded, "PURCHASE_CLOSED");
        require(block.timestamp <= purchase.purchasedAt + SETTLE_WINDOW, "SETTLE_WINDOW_CLOSED");

        purchase.settledAt = block.timestamp;

        unsettledVynar -= purchase.amount;
        unsettledOf[purchase.player] -= purchase.amount;

        uint256 toStaking = (purchase.amount * STAKING_BPS) / BASIS;
        uint256 toTreasury = purchase.amount - toStaking;

        // La diferencia va a tesoreria en vez de repartirse entre los dos por
        // bps. Si se calculara los dos por separado, el redondeo dejaria uno o
        // dos wei sin destino y `unsettledVynar` dejaria de cuadrar con el saldo.
        stakingRewards += toStaking;
        treasuryBalance += toTreasury;
        stakingAccruedAt = block.timestamp;
        treasuryAccruedAt = block.timestamp;

        emit PurchaseSettled(purchaseId, toStaking, toTreasury);
    }

    /**
     * @notice Devuelve el importe de una compra que no se liquido a tiempo.
     * @dev Lo puede llamar cualquiera y el destino es SIEMPRE el comprador, que
     *      esta grabado en la compra. Que no sea `msg.sender` es lo que hace que
     *      un tercero pueda ayudar a cerrar una compra sin poder quedarsela.
     *
     *      Solo funciona con compras no liquidadas: una vez repartido, el dinero
     *      pertenece a los stakers y a la tesoreria, y devolverlo seria robarles.
     */
    function refundPurchase(bytes32 purchaseId) external nonReentrant {
        Purchase storage purchase = purchases[purchaseId];
        require(purchase.purchasedAt != 0, "PURCHASE_UNKNOWN");
        require(!purchase.refunded && purchase.settledAt == 0, "PURCHASE_CLOSED");

        purchase.refunded = true;

        unsettledVynar -= purchase.amount;
        unsettledOf[purchase.player] -= purchase.amount;

        vynar.safeTransfer(purchase.player, purchase.amount);
        emit PurchaseRefunded(purchaseId, purchase.player, purchase.amount);
    }

    /**
     * @notice Mueve saldo a los stakers via `StakingVault.notifyRewardVynar`.
     * @dev El allowance se renueva con `forceApprove` porque `notifyRewardVynar`
     *      hace `safeTransferFrom` y una allowance que ya se consumio haria fallar
     *      la siguiente llamada sin motivo visible.
     *
     *      El plazo es sobre el saldo completo y por eso `stakingAccruedAt` se
     *      reinicia en cada llamada: quien enruta a diario no espera nada, y quien
     *      lo hace una vez paga el plazo una vez.
     */
    function routeToStaking(uint256 amount) external onlyOwner nonReentrant {
        require(amount > 0, "ZERO_AMOUNT");
        require(amount <= stakingRewards, "INSUFFICIENT_STAKING_BALANCE");
        require(block.timestamp >= stakingAccruedAt + ROUTING_DELAY, "ROUTING_DELAY");

        stakingRewards -= amount;
        stakingAccruedAt = block.timestamp;

        vynar.forceApprove(address(stakingVault), amount);
        stakingVault.notifyRewardVynar(amount);

        emit RoutedToStaking(amount);
    }

    /// @notice Retira a tesoreria. Plazo mas largo que el de los stakers.
    function withdrawTreasury(address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "ZERO_RECIPIENT");
        require(amount > 0, "ZERO_AMOUNT");
        require(amount <= treasuryBalance, "INSUFFICIENT_TREASURY_BALANCE");
        require(block.timestamp >= treasuryAccruedAt + TREASURY_DELAY, "TREASURY_DELAY");

        treasuryBalance -= amount;
        treasuryAccruedAt = block.timestamp;

        vynar.safeTransfer(to, amount);
        emit TreasuryWithdrawn(to, amount);
    }

    /// @notice Suma de los tres saldos. Tiene que coincidir con el VYNAR que el
    ///         contrato tiene en la cartera, y la diferencia es la que
    ///         `solvency()` expone: si no es cero, algo minteo o entro sin
    ///         contabilizar.
    function accountedBalance() public view returns (uint256) {
        return unsettledVynar + stakingRewards + treasuryBalance;
    }

    function solvency() external view returns (int256) {
        return int256(vynar.balanceOf(address(this))) - int256(accountedBalance());
    }

    function _isPlayable(uint8 arena) internal pure returns (bool) {
        uint8[] memory arenas = playableArenas();
        for (uint256 i = 0; i < arenas.length; i++) {
            if (arenas[i] == arena) return true;
        }
        return false;
    }

    event PurchaseCollected(bytes32 indexed purchaseId, address indexed player, uint8 arena, uint256 units, uint256 amount);
    event PurchaseSettled(bytes32 indexed purchaseId, uint256 toStaking, uint256 toTreasury);
    event PurchaseRefunded(bytes32 indexed purchaseId, address indexed player, uint256 amount);
    event RoutedToStaking(uint256 amount);
    event TreasuryWithdrawn(address indexed to, uint256 amount);
}