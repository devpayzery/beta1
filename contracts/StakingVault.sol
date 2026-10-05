// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

interface IVynarMinter {
    function mint(address to, uint256 amount) external;
}

/**
 * @title StakingVault
 * @notice Staking de SVP y VYNAR con rendimiento diario y bloqueo de 1 dia.
 * @notice Solo administra fondos de staking. Los saldos de boosters y de LP viven
 *         en otros contratos y jamas se comminglean con este.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EL TRAMPOSO QUE ESTE CONTRATO ESTA DISEÑADO PARA EVITAR
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * La primera versión de este diseño tenía "cobro solo de días completados" así:
 *
 *     pending = staked × accPricePerShare × diasTranscurridos
 *
 * Eso está mal y sobrepaga de forma masiva. `accPricePerShare` es ACUMULADO desde
 * el inicio del pool, no por día. Con 100 tokens staked, un precio que sube de 1.0 a
 * 1.5 en cinco días, y un usuario que no toca nada hasta el día 5:
 *
 *     100 × 1.5 × 5 = 750        <- lo que daría la fórmula
 *     100 × 0.5     = 50         <- lo que realmente hay en el pool
 *
 * Un solo usuario que espera 5 días se llevaría 15× el pool entero y lo dejaría
 * insolvente. El día completo no es un multiplicador: es una PUERTA.
 *
 * La solución es que `accPricePerShare` solo avanza cuando un día se cierra
 * (_closeDays), y el accrue de un usuario es la diferencia contra el precio que
 * tenía en su último settle:
 *
 *     pending += staked × (accPricePerShare - debtPrice) / 1e18
 *
 * El día completo controla CUÁNTO se acredita, no multiplica el resultado. El
 * resultado es siempre la diferencia real de precio, se haya acumulados durante
 * un día o durante mil.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUE NO HAY SHARES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * No hay share price. El principio es `stakedTotal` contra `rewardReserve`, y el
 * `rewardReserve` SOLO crece con `notifyReward` / `topUpFromMint`.
 *
 * Eso hace que una donación directa al contrato sea inofensiva: los tokens
 * donados no entran en `rewardReserve`, así que nadie puede reclamarlos. Solo
 * `rescue` los saca, y solo el owner. Con shares, una donación sube el precio y
 * hay que acertar la aritmética de dilución para que el resultado sea el mismo.
 * Menos código, mismo resultado, un vector menos.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SVP NO SE PUEDE MINTEAR
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `topUpFromMint` solo existe para VYNAR. SVP es la moneda de gas de la cadena:
 * su rendimiento solo puede venir de fees reales. Si el ingreso real no alcanza,
 * el rendimiento se detiene, que es el comportamiento correcto. Un staker de SVP
 * nunca puede recibir rendimiento de emisión ficticia, y eso no requiere ninguna
 * configuración: es una limitación del activo.
 */
contract StakingVault is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Pool {
        SVP,
        VYNAR
    }

    struct PoolState {
        uint256 stakedTotal;
        uint256 accPricePerShare; // 1e18, monotono, solo avanza al cerrar dia
        uint256 lastClosedDay;
        uint256 rewardReserve;    // owed como recompensa,incluido undistributed
        uint256 undistributed;    // notificado y aun no liberado
        uint256 totalReleased;
        uint256 totalClaimed;
        uint256 fundedFromFees;
        uint256 fundedFromMint;
        bool paused;
    }

    struct UserState {
        uint256 staked;
        uint256 debtPrice;    // accPricePerShare en el ultimo settle
        uint256 pending;      // ganado, sujeto al lock
        uint64 lastActionAt;
    }

    uint256 public constant DAY = 1 days;
    uint256 public constant PRICE_SCALE = 1e18;
    uint256 public constant BASIS = 10000;

    /// @notice Plazo desde la ultima accion del usuario hasta que puede retirar o cobrar.
    uint256 public constant WITHDRAW_LOCK = 1 days;

    /// @notice Techo diario por pool. Un tope que el owner puede mover no es una
    ///         garantia: lo que protege es que el owner sea un timelock.
    uint256 public constant MAX_DAILY_RATE_BPS = 2000; // 20%

    IERC20 public immutable vynar;
    address public minter;

    mapping(Pool => PoolState) public pools;
    mapping(Pool => mapping(address => UserState)) public users;

    /// @notice Tasa diaria por pool, en bps del TVL. 1300 = 13% techo.
    mapping(Pool => uint256) public dailyRateBps;

    event Staked(Pool indexed pool, address indexed user, uint256 amount);
    event Unstaked(Pool indexed pool, address indexed user, uint256 amount);
    event Claimed(Pool indexed pool, address indexed user, uint256 amount);
    event RewardNotified(Pool indexed pool, uint256 amount, bool fromMint);
    event DaysClosed(Pool indexed pool, uint256 dayCount, uint256 released);
    event DailyRateUpdated(Pool indexed pool, uint256 oldBps, uint256 newBps);
    event PoolPaused(Pool indexed pool, bool paused);
    event MinterUpdated(address indexed minter);
    event ExcessRescued(address indexed to, uint256 amount);

    constructor(address _vynar, address initialOwner) Ownable(initialOwner) {
        require(_vynar != address(0), "INVALID_TOKEN");
        vynar = IERC20(_vynar);
        // 13% es el techo de diseno, no un punto de partida. Bajar la tasa real es
        // una tx y no requiere redeploy.
        dailyRateBps[Pool.SVP] = 1300;
        dailyRateBps[Pool.VYNAR] = 1300;
    }

    // ═══════════════════════════════════════════════════════════
    //  MODIFICADORES
    // ═══════════════════════════════════════════════════════════

    function _live(Pool pool) internal view {
        require(!pools[pool].paused, "POOL_PAUSED");
    }

    modifier live(Pool pool) {
        _live(pool);
        _;
    }

    function _authorizeMint() internal view {
        require(msg.sender == minter, "NOT_MINTER");
    }

    // ═══════════════════════════════════════════════════════════
    //  STAKING
    // ═══════════════════════════════════════════════════════════

    /// @notice Deposita SVP (nativo) en el pool SVP.
    function stakeSvp() external payable live(Pool.SVP) nonReentrant {
        require(msg.value > 0, "ZERO_AMOUNT");
        _stake(Pool.SVP, msg.sender, msg.value);
    }

    /// @notice Deposita VYNAR en el pool VYNAR.
    function stakeVynar(uint256 amount) external live(Pool.VYNAR) nonReentrant {
        require(amount > 0, "ZERO_AMOUNT");
        vynar.safeTransferFrom(msg.sender, address(this), amount);
        _stake(Pool.VYNAR, msg.sender, amount);
    }

    function _stake(Pool pool, address user, uint256 amount) internal {
        _closeDays(pool);
        // Settle ANTES de cambiar `staked`: si no, el stake nuevo se atribuiría
        // retroactivamente todo el rendimiento acumulado desde su último settle.
        _settle(pool, user);

        UserState storage u = users[pool][user];
        u.staked += amount;
        u.lastActionAt = uint64(block.timestamp);
        pools[pool].stakedTotal += amount;

        emit Staked(pool, user, amount);
    }

    function unstake(Pool pool, uint256 amount) external live(pool) nonReentrant {
        UserState storage u = users[pool][msg.sender];
        require(u.staked >= amount, "INSUFFICIENT_STAKE");
        require(block.timestamp >= uint256(u.lastActionAt) + WITHDRAW_LOCK, "LOCKED");

        _closeDays(pool);
        _settle(pool, msg.sender);

        u.staked -= amount;
        pools[pool].stakedTotal -= amount;
        _payout(pool, msg.sender, amount);

        emit Unstaked(pool, msg.sender, amount);
    }

    /// @notice Cobra el rendimiento acumulado de dias ya cerrados.
    /// @dev Requiere el mismo lock que unstake. Quien solo cobra no puede
    ///      reinvertir en el mismo bloque y volver a cobrar: ese bucle es
    ///      exactamente lo que el lock de 1 dia cierra.
    function claim(Pool pool) external live(pool) nonReentrant {
        UserState storage u = users[pool][msg.sender];
        require(block.timestamp >= uint256(u.lastActionAt) + WITHDRAW_LOCK, "LOCKED");

        _closeDays(pool);
        _settle(pool, msg.sender);

        uint256 amount = u.pending;
        require(amount > 0, "NOTHING_TO_CLAIM");
        u.pending = 0;
        u.lastActionAt = uint64(block.timestamp);

        PoolState storage p = pools[pool];
        p.rewardReserve -= amount;
        p.totalClaimed += amount;

        _payout(pool, msg.sender, amount);
        emit Claimed(pool, msg.sender, amount);
    }

    /// @notice Cobro combinado de stake+yield en una sola transaccion.
    function claimAndUnstake(Pool pool, uint256 amount) external live(pool) nonReentrant {
        UserState storage u = users[pool][msg.sender];
        require(u.staked >= amount, "INSUFFICIENT_STAKE");
        require(block.timestamp >= uint256(u.lastActionAt) + WITHDRAW_LOCK, "LOCKED");

        _closeDays(pool);
        _settle(pool, msg.sender);

        u.staked -= amount;
        pools[pool].stakedTotal -= amount;

        uint256 reward = u.pending;
        if (reward > 0) {
            u.pending = 0;
            PoolState storage p = pools[pool];
            p.rewardReserve -= reward;
            p.totalClaimed += reward;
        }
        u.lastActionAt = uint64(block.timestamp);

        _payout(pool, msg.sender, amount + reward);
        emit Unstaked(pool, msg.sender, amount);
        if (reward > 0) emit Claimed(pool, msg.sender, reward);
    }

    // ═══════════════════════════════════════════════════════════
    //  ACUMULACION
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice Cierra todos los dias completos hasta ahora y libera el rendimiento.
     * @dev Quien llama es cualquiera: no hay estado por usuario aqui, solo el pool.
     *
     *      APPROXIMACION DECLARADA: el presupuesto diario se calcula con el
     *      `stakedTotal` de ESTE instante y se aplica a todos los dias pendientes.
     *      Si el TVL subio o bajo durante el periodo, el reparto real de cada dia
     *      habria sido distinto. El error esta acotado por `undistributed`: lo que
     *      se libera nunca excede lo que se notificó como ingreso real, asi que
     *      esto reparte mal en el tiempo, nunca de más. Aceptable para un staker;
     *      no lo seria para una contabilidad fiscal.
     */
    function _closeDays(Pool pool) internal {
        PoolState storage p = pools[pool];
        uint256 target = block.timestamp / DAY;
        if (target <= p.lastClosedDay) return;
        uint256 dayCount = target - p.lastClosedDay;
        p.lastClosedDay = target;

        // Sin stakers no hay a quien distribuir. undistributed espera, no se pierde.
        if (p.stakedTotal == 0) return;

        uint256 budget = Math.mulDiv(p.stakedTotal, dailyRateBps[pool], BASIS);
        uint256 want = budget * dayCount;
        uint256 released = Math.min(want, p.undistributed);
        if (released == 0) return;

        p.undistributed -= released;
        p.totalReleased += released;
        // Redondeo hacia abajo: favorece al pool. Nunca se distribuye de más y
        // el resto queda como undistributed para el siguiente dia.
        p.accPricePerShare += Math.mulDiv(released, PRICE_SCALE, p.stakedTotal);

        emit DaysClosed(pool, dayCount, released);
    }

    /// @dev Credita a `user` la diferencia de precio desde su ultimo settle.
    ///      Nunca se llama despues de cambiar `staked` del usuario en la misma tx.
    function _settle(Pool pool, address user) internal {
        UserState storage u = users[pool][user];
        uint256 price = pools[pool].accPricePerShare;
        if (price > u.debtPrice) {
            u.pending += Math.mulDiv(u.staked, price - u.debtPrice, PRICE_SCALE);
        }
        u.debtPrice = price;
    }

    // ═══════════════════════════════════════════════════════════
    //  FINANCIACION
    // ═══════════════════════════════════════════════════════════

    /// @notice Notifica ingreso real de fees. Solo el owner.
    /// @dev Para SVP el valor llega como nativo. Este es el UNICO camino por el que
    ///      un staker de SVP puede ganar: no hay fallback a mint porque SVP no se
    ///      puede mintear.
    function notifyRewardSvp() external payable onlyOwner {
        require(msg.value > 0, "ZERO_AMOUNT");
        _addReward(Pool.SVP, msg.value, false);
    }

    /// @notice Notifica ingreso real de fees en VYNAR (recaudado por boosters).
    function notifyRewardVynar(uint256 amount) external onlyOwner nonReentrant {
        require(amount > 0, "ZERO_AMOUNT");
        vynar.safeTransferFrom(msg.sender, address(this), amount);
        _addReward(Pool.VYNAR, amount, false);
    }

    /**
     * @notice Emite VYNAR para cubrir el faltante de rendimiento.
     * @dev Deliberadamente EXPLICITO y separado de notifyReward, en vez de un mint
     *      automatico dentro de _closeDays. Consecuencia: el contrato nunca mintea
     *      sin una transaccion deliberada, y la proporcion fundedFromFees /
     *      fundedFromMint es exactamente lo notificado, no una estimacion.
     *
     *      Si nadie llama a esto, el rendimiento de VYNAR se detiene cuando el
     *      ingreso real se agota. Preferible a emitir de mas.
     */
    function topUpFromMint(Pool pool, uint256 amount) external {
        _authorizeMint();
        require(pool == Pool.VYNAR, "NOT_MINTABLE");
        require(amount > 0, "ZERO_AMOUNT");

        // vynar es IERC20 para los transfers y se castea a IVynarMinter solo en topUpFromMint.
// Un segundo immutable apuntando al mismo address seria redundante.
        IVynarMinter(address(vynar)).mint(address(this), amount);
        _addReward(pool, amount, true);
    }

    function _addReward(Pool pool, uint256 amount, bool fromMint) internal {
        PoolState storage p = pools[pool];
        p.rewardReserve += amount;
        p.undistributed += amount;
        if (fromMint) {
            p.fundedFromMint += amount;
        } else {
            p.fundedFromFees += amount;
        }
        emit RewardNotified(pool, amount, fromMint);
    }

    /// @notice Adelanta el cierre de dias sin llamarla por otra via.
    function poke(Pool pool) external {
        _closeDays(pool);
    }

    // ═══════════════════════════════════════════════════════════
    //  PAGOS
    // ═══════════════════════════════════════════════════════════

    function _payout(Pool pool, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (pool == Pool.SVP) {
            (bool sent,) = to.call{value: amount}("");
            require(sent, "TRANSFER_FAILED");
        } else {
            vynar.safeTransfer(to, amount);
        }
    }

    receive() external payable {
        // Donaciones directas. NO entran en rewardReserve, asi que ningún staker
        // puede reclamarlas: se recuperan con rescue. Sin este camino, un envio
        // accidental por error de red se quedaria atascado para siempre.
    }

    // ═══════════════════════════════════════════════════════════
    //  VISTAS
    // ═══════════════════════════════════════════════════════════

    function pendingOf(Pool pool, address user) external view returns (uint256) {
        UserState storage u = users[pool][user];
        uint256 price = pools[pool].accPricePerShare;
        uint256 extra = price > u.debtPrice ? Math.mulDiv(u.staked, price - u.debtPrice, PRICE_SCALE) : 0;
        return u.pending + extra;
    }

    /// @notice Cuando el usuario puede volver a retirar o cobrar.
    function claimableAt(Pool pool, address user) external view returns (uint256) {
        return uint256(users[pool][user].lastActionAt) + WITHDRAW_LOCK;
    }

    /**
     * @notice Proporcion del rendimiento sostenido por ingreso real vs mint.
     * @dev Es el numero que hay que mirar antes de anunciar un APR. Un pool
     *      financiado al 100% por mint no es un yield, es dilución, y las dos
     *      cosas se ven igual en un dashboard que solo muestre el APR.
     * @return feesBps 0..10000, partevenir de fees reales
     */
    function fundingSplit(Pool pool) external view returns (uint256 feesBps, uint256 mintBps) {
        PoolState storage p = pools[pool];
        uint256 total = p.fundedFromFees + p.fundedFromMint;
        if (total == 0) return (0, 0);
        feesBps = Math.mulDiv(p.fundedFromFees, BASIS, total);
        return (feesBps, BASIS - feesBps);
    }

    /// @notice Solvencia de un pool: lo que el contrato debe menos lo que tiene.
    /// @dev negative = pasivo. Es la unica cifra que hay que monitorear.
    function solvency(Pool pool) external view returns (int256) {
        uint256 balance = pool == Pool.SVP
            ? address(this).balance
            : vynar.balanceOf(address(this));
        uint256 owed = pools[pool].stakedTotal + pools[pool].rewardReserve;
        return int256(balance) - int256(owed);
    }

    function dailyBudget(Pool pool) external view returns (uint256) {
        return Math.mulDiv(pools[pool].stakedTotal, dailyRateBps[pool], BASIS);
    }

    // ═══════════════════════════════════════════════════════════
    //  ADMIN
    // ═══════════════════════════════════════════════════════════

    function setDailyRate(Pool pool, uint256 bps) external onlyOwner {
        require(bps <= MAX_DAILY_RATE_BPS, "RATE_TOO_HIGH");
        uint256 old = dailyRateBps[pool];
        dailyRateBps[pool] = bps;
        emit DailyRateUpdated(pool, old, bps);
    }

    function setPaused(Pool pool, bool paused) external onlyOwner {
        pools[pool].paused = paused;
        emit PoolPaused(pool, paused);
    }

    function setMinter(address newMinter) external onlyOwner {
        minter = newMinter;
        emit MinterUpdated(newMinter);
    }

    /**
     * @notice Recupera el excedente por encima de lo comprometido en los dos pools.
     * @dev Es el UNICO camino por el que el contrato puede dar SVP o VYNAR que no
     *      sean staked o recompensas. Las donaciones caen aqui por construccion:
     *      no son reclamables por ningun staker.
     *
     *      La garantia es aritmetica, no un flag: los dos owed se suman antes de
     *      restar. Que un pool este pausado no es requisito, porque pausar no
     *      cambia la aritmetica y anadir el requisito solo haria el rescate
     *      imposible en el momento en que mas urge.
     */
    function rescue(address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "ZERO_TO");
        uint256 balance = address(this).balance;
        uint256 owedSvp = pools[Pool.SVP].stakedTotal + pools[Pool.SVP].rewardReserve;
        require(balance > owedSvp, "NO_EXCESS");
        uint256 max = balance - owedSvp;
        require(amount <= max, "AMOUNT_EXCEEDS_EXCESS");
        (bool sent,) = to.call{value: amount}("");
        require(sent, "TRANSFER_FAILED");
        emit ExcessRescued(to, amount);
    }

    function rescueVynar(address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "ZERO_TO");
        uint256 balance = vynar.balanceOf(address(this));
        uint256 owedVynar = pools[Pool.VYNAR].stakedTotal + pools[Pool.VYNAR].rewardReserve;
        require(balance > owedVynar, "NO_EXCESS");
        uint256 max = balance - owedVynar;
        require(amount <= max, "AMOUNT_EXCEEDS_EXCESS");
        vynar.safeTransfer(to, amount);
        emit ExcessRescued(to, amount);
    }
}