// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title VynarRewardsV3
 * @notice Distribucion de pools VYNAR con winners firmados, cancelacion y payout
 *         sin custodia. Correccion de la auditoria sobre VynarRewardsV2.
 * @dev EIP-712 domain: "VynarRewardsV2" / "1"  (dominio sin cambios: la app firma con este)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUE CAMBIA RESPECTO A V2 Y POR QUE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * [C2] withdraw() IGNORABA TODAS LAS ARENAS QUE NO FUERAN 0 NI 1.
 *      V2:271 hacia literally
 *          require(balance >= reservedBalance[0] + reservedBalance[1] + amount, ...)
 *      reservedBalance es mapping(uint8 => uint256) y arena admite 0..255, asi
 *      que solo 2 de 256 arenas estaban protegidas. El dia que se agrega un
 *      tercer modo de juego, los fondos reservados para los ganadores de esa
 *      arena se vuelven retirables por el owner. Es la feature que dispara el
 *      bug, no lo evita.
 *      Aqui los arenas usados se registran en una lista y totalReserved() itera
 *      sobre ella. Un solo openEpoch nuevo queda protegido automaticamente.
 *
 * [M6] WITHDRAW_DELAY = 30 days ESTABA DECLARADO PERO NUNCA APLICADO.
 *      El NatSpec de V2 decia "Solo despues de 30 dias del settled y sin claims
 *      pendientes", pero withdraw no tenia ninguna comprobacion de tiempo. La
 *      constante era muerta y el comentario moria. El owner podia retirar en el
 *      mismo bloque en que aterrizaban los fondos.
 *      Aqui se aplica contra latestSettledAt.
 *
 * [H-FEATURE] claim() ES msg.sender Y NO ACEPTA DESTINATARIO.
 *      Impide que el servidor empuje el pago sin que el ganador tenga que iniciar
 *      la transaccion. Se agrega claimTo, restringido al signer. Los fondos van
 *      directo al recipient: no hay custodia intermedia.
 *
 * [M-NUEVO] percentages PODIA CONTENER CEROS, DEJANDO SLOTS IRRECLAMABLES.
 *      _claim revierte con ZERO_REWARD si el porcentaje es 0, asi que ese ganador
 *      no podia reclamar nunca y su parte quedaba bloqueada. openEpoch ahora exige
 *      que todos los porcentajes sean > 0.
 *
 * [M-NUEVO] cancelEpoch NO ERA nonReentrant aunque hace safeTransfer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MODELO DE CONTABILIDAD
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * El pool de cada epoch es un monto EXPLICITO de VYNAR, fijado en openEpoch y
 * visible on-chain en EpochOpened. Esa es la garantia de trazabilidad que pediste:
 * se puede demonstrating de donde sale cada pago de VYNAR del leaderboard leyendo
 * una sola evento.
 *
 * openEpoch exige que el contrato ya tenga el saldo: NO mintea. El flujo es
 *   1. VYNAR.mint(rewardsContract, pool)        (solo un minter)
 *   2. rewards.openEpoch(arena, epoch, pool, percentages)
 * Los dos pasos van separados a proposito: si openEpoch fallara, los fondos ya
 * estan en el contrato y son recuperables con withdraw una vez pasado
 * WITHDRAW_DELAY, en vez de quemados.
 */
contract VynarRewardsV3 is Ownable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;

    IERC20 public immutable vynarToken;
    address public signer;
    address public publisher;

    uint256 public constant BASIS = 10000;
    uint256 public constant MAX_WINNERS = 20;

    /// @notice [M6] Plazo minimo desde el ultimo settle antes de poder retirar.
    uint256 public constant WITHDRAW_DELAY = 30 days;

    struct EpochReward {
        uint256 pool;
        uint256 positionCount;
        uint256[] percentages;
        address[] winners;
        uint256 totalClaimed;
        uint256 settledAt;
        bool funded;
        bool settled;
        bool canceled;
    }

    mapping(uint8 => mapping(uint256 => EpochReward)) public epochRewards;
    mapping(uint8 => mapping(uint256 => mapping(address => bool))) public claimed;
    mapping(uint8 => uint256[]) public epochList;
    mapping(uint8 => uint256) public reservedBalance;

    /// @notice [C2] Arenas que han abierto alguna epoch. Ninguno se pre-registra:
    ///         basta un openEpoch para que su reservado entre en totalReserved().
    mapping(uint8 => bool) internal _arenaRegistered;
    uint8[] internal _registeredArenas;

    /// @notice [M6] Timestamp del settle mas reciente. Gate de withdraw.
    uint256 public latestSettledAt;

    bytes32 public constant WINNERS_TYPEHASH = keccak256(
        "Winners(uint8 arena,uint256 epoch,address[] winners,uint256 deadline)"
    );

    event SignerUpdated(address indexed signer);
    event PublisherUpdated(address indexed publisher);
    event EpochOpened(uint8 indexed arena, uint256 indexed epoch, uint256 pool, uint256 positionCount);
    event WinnersSubmitted(uint8 indexed arena, uint256 indexed epoch, address[] winners);
    event RewardClaimed(uint8 indexed arena, uint256 indexed epoch, address indexed player, uint256 amount);
    event RewardClaimedTo(uint8 indexed arena, uint256 indexed epoch, address indexed recipient, uint256 amount);
    event EpochCanceled(uint8 indexed arena, uint256 indexed epoch, uint256 refunded);
    event Withdrawn(address indexed to, uint256 amount);
    event ArenaRegistered(uint8 indexed arena);

    constructor(address _vynarToken, address _signer, address initialOwner)
        EIP712("VynarRewardsV2", "1")
        Ownable(initialOwner)
    {
        require(_vynarToken != address(0), "INVALID_TOKEN");
        require(_signer != address(0), "INVALID_SIGNER");
        vynarToken = IERC20(_vynarToken);
        signer = _signer;
        publisher = _signer;
    }

    // ═══════════════════════════════════════════════════════════
    //  MODIFICADORES
    // ═══════════════════════════════════════════════════════════

    modifier onlySigner() {
        require(msg.sender == signer, "NOT_SIGNER");
        _;
    }

    modifier onlyOwnerOrSigner() {
        require(msg.sender == owner() || msg.sender == signer, "NOT_AUTHORIZED");
        _;
    }

    modifier onlyOwnerOrPublisher() {
        require(msg.sender == owner() || msg.sender == publisher, "NOT_PUBLISHER");
        _;
    }

    // ═══════════════════════════════════════════════════════════
    //  ADMIN
    // ═══════════════════════════════════════════════════════════

    function setSigner(address _signer) external onlyOwner {
        require(_signer != address(0), "INVALID_SIGNER");
        signer = _signer;
        emit SignerUpdated(_signer);
    }

    function setPublisher(address _publisher) external onlyOwner {
        require(_publisher != address(0), "INVALID_PUBLISHER");
        publisher = _publisher;
        emit PublisherUpdated(_publisher);
    }

    // ═══════════════════════════════════════════════════════════
    //  ABRIR EPOCH
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice Abre una epoch con un pool EXPLICITO de VYNAR.
     * @dev No mintea: los tokens deben estar ya en el contrato. Ver seccion
     *      MODELO DE CONTABILIDAD.
     * @param percentages Reparto en bps. Debe sumar BASIS y ser todos > 0.
     *        El chequeo de > 0 evita winners con slots irreclamables: _claim
     *        revierte con ZERO_REWARD en un porcentaje 0 y ese fondo queda
     *        bloqueado para siempre.
     */
    function openEpoch(
        uint8 arena,
        uint256 epoch,
        uint256 pool,
        uint256[] calldata percentages
    ) external onlyOwnerOrPublisher {
        EpochReward storage r = epochRewards[arena][epoch];
        require(!r.funded, "ALREADY_OPEN");
        require(pool > 0, "INVALID_POOL");
        require(percentages.length > 0 && percentages.length <= MAX_WINNERS, "INVALID_COUNT");

        uint256 sum = 0;
        for (uint256 i = 0; i < percentages.length; i++) {
            require(percentages[i] > 0, "ZERO_PERCENTAGE");
            sum += percentages[i];
        }
        require(sum == BASIS, "SUM_MUST_BE_10000");
        require(vynarToken.balanceOf(address(this)) >= pool, "INSUFFICIENT_BALANCE");

        // [C2] Registrar el arena ANTES de tocar reservedBalance, para que
        // totalReserved() lo incluya desde el mismo momento en que hay fondos
        // comprometidos.
        _registerArena(arena);

        r.pool = pool;
        r.positionCount = percentages.length;
        r.percentages = percentages;
        r.funded = true;
        reservedBalance[arena] += pool;
        epochList[arena].push(epoch);

        emit EpochOpened(arena, epoch, pool, percentages.length);
    }

    function _registerArena(uint8 arena) internal {
        if (!_arenaRegistered[arena]) {
            _arenaRegistered[arena] = true;
            _registeredArenas.push(arena);
            emit ArenaRegistered(arena);
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  SOMETER GANADORES
    // ═══════════════════════════════════════════════════════════

    function submitWinners(
        uint8 arena,
        uint256 epoch,
        address[] calldata winners
    ) external onlySigner {
        _submitWinners(arena, epoch, winners);
    }

    /// @notice Cualquiera puede someter si tiene la firma del signer.
    function submitWinnersWithSignature(
        uint8 arena,
        uint256 epoch,
        address[] calldata winners,
        uint256 deadline,
        bytes calldata signature
    ) external {
        require(block.timestamp <= deadline, "EXPIRED");

        bytes32 structHash = keccak256(abi.encode(
            WINNERS_TYPEHASH,
            arena,
            epoch,
            _hashWinners(winners),
            deadline
        ));
        bytes32 digest = _hashTypedDataV4(structHash);

        address recovered = ECDSA.recover(digest, signature);
        require(recovered == signer, "BAD_SIGNATURE");

        _submitWinners(arena, epoch, winners);
    }

    /// @dev abi.encodePacked sobre bytes32[] es seguro: todos los elementos son
    ///      de ancho fijo, no hay ambiguedad de encoding.
    function _hashWinners(address[] calldata winners) internal pure returns (bytes32) {
        bytes32[] memory encoded = new bytes32[](winners.length);
        for (uint256 i = 0; i < winners.length; i++) {
            encoded[i] = bytes32(uint256(uint160(winners[i])));
        }
        return keccak256(abi.encodePacked(encoded));
    }

    function _submitWinners(
        uint8 arena,
        uint256 epoch,
        address[] calldata winners
    ) internal {
        EpochReward storage r = epochRewards[arena][epoch];
        require(r.funded, "NOT_FUNDED");
        require(!r.settled, "ALREADY_SETTLED");
        require(!r.canceled, "CANCELED");
        require(winners.length == r.positionCount, "WRONG_LENGTH");

        for (uint256 i = 0; i < winners.length; i++) {
            require(winners[i] != address(0), "ZERO_WINNER");
            for (uint256 j = 0; j < i; j++) {
                require(winners[i] != winners[j], "DUPLICATE_WINNER");
            }
        }

        r.winners = winners;
        r.settled = true;
        r.settledAt = block.timestamp;
        if (block.timestamp > latestSettledAt) {
            latestSettledAt = block.timestamp;
        }

        emit WinnersSubmitted(arena, epoch, winners);
    }

    // ═══════════════════════════════════════════════════════════
    //  CANCELAR EPOCH
    // ═══════════════════════════════════════════════════════════

    /// @notice [M-NUEVO] nonReentrant: hace safeTransfer.
    /// @dev Solo epochs NO settle. No hay claims posibles antes del settle, asi
    ///      que no hace falta revertir nada.
    function cancelEpoch(uint8 arena, uint256 epoch) external onlyOwnerOrSigner nonReentrant {
        EpochReward storage r = epochRewards[arena][epoch];
        require(r.funded, "NOT_FUNDED");
        require(!r.settled, "ALREADY_SETTLED");
        require(!r.canceled, "ALREADY_CANCELED");

        r.canceled = true;
        uint256 refundAmount = r.pool;
        reservedBalance[arena] -= refundAmount;
        if (refundAmount > 0) {
            vynarToken.safeTransfer(owner(), refundAmount);
        }

        emit EpochCanceled(arena, epoch, refundAmount);
    }

    // ═══════════════════════════════════════════════════════════
    //  CLAIM
    // ═══════════════════════════════════════════════════════════

    function claim(uint8 arena, uint256 epoch) external nonReentrant {
        _claim(arena, epoch, msg.sender);
    }

    /// @notice Reclama varias epochs de una sola vez.
    function batchClaim(uint8 arena, uint256[] calldata epochs) external nonReentrant {
        for (uint256 i = 0; i < epochs.length; i++) {
            _claim(arena, epochs[i], msg.sender);
        }
    }

    /**
     * @notice [H-FEATURE] Push desde el servidor sin custodia.
     * @dev Solo el signer. La seguridad no depende del permiso sino de _claim:
     *      solo un address presente en r.winners puede ser recipient, asi que
     *      empujar a una direccion equivocada es imposible por construccion.
     *
     *      Ventana de seguridad sugerida: NO llamar esto en el mismo bloque del
     *      settle. Determinar ganadores y empujar en el mismo instante convierte
     *      un off-by-one de rank en dinero irreversible en la direccion equivocada.
     *      El batch server-side deberia correr 2+ horas despues del settle.
     */
    function claimTo(
        uint8 arena,
        uint256 epoch,
        address recipient
    ) external onlySigner nonReentrant {
        require(recipient != address(0), "ZERO_RECIPIENT");
        uint256 amount = _claim(arena, epoch, recipient);
        if (amount > 0) {
            emit RewardClaimedTo(arena, epoch, recipient, amount);
        }
    }

    function _claim(uint8 arena, uint256 epoch, address player) internal returns (uint256 amount) {
        EpochReward storage r = epochRewards[arena][epoch];
        require(r.settled, "NOT_SETTLED");
        require(!r.canceled, "CANCELED");
        require(!claimed[arena][epoch][player], "ALREADY_CLAIMED");

        uint256 position = type(uint256).max;
        for (uint256 i = 0; i < r.winners.length; i++) {
            if (r.winners[i] == player) {
                position = i;
                break;
            }
        }
        require(position != type(uint256).max, "NOT_WINNER");

        amount = (r.pool * r.percentages[position]) / BASIS;
        require(amount > 0, "ZERO_REWARD");

        claimed[arena][epoch][player] = true;
        r.totalClaimed += amount;
        reservedBalance[arena] -= amount;
        vynarToken.safeTransfer(player, amount);

        emit RewardClaimed(arena, epoch, player, amount);
    }

    // ═══════════════════════════════════════════════════════════
    //  RETIRO
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice [C2][M6] Retira VYNAR no comprometido.
     * @dev Las dos correcciones criticas de esta funcion:
     *
     *      1. El reserved se calcula con totalReserved(), que itera TODOS los
     *         arenas registrados. V2 hardcodeaba reservedBalance[0] +
     *         reservedBalance[1], dejando 254 arenas desprotegidas.
     *
     *      2. Hay un gate de tiempo. WITHDRAW_DELAY estaba declarado en V2 pero
     *         nunca se compruebava; el comentario prometia 30 dias que el codigo
     *         no aplicaba.
     *
     *      Safecast: reservedBalance es el unico ilegable de un atacante, pero
     *      aun asi es un uint256 normal. Si por lo que sea fuera menor que el
     *      saldo real, esto solo permits mover VYNAR que ya estaba sin reclamar.
     */
    function withdraw(uint256 amount) external onlyOwner nonReentrant {
        require(amount > 0, "INVALID_AMOUNT");
        require(
            block.timestamp >= latestSettledAt + WITHDRAW_DELAY,
            "WITHDRAW_DELAY_NOT_MET"
        );

        uint256 balance = vynarToken.balanceOf(address(this));
        require(balance >= totalReserved() + amount, "AMOUNT_RESERVED");

        vynarToken.safeTransfer(owner(), amount);
        emit Withdrawn(owner(), amount);
    }

    /**
     * @notice [C2] Suma de reservedBalance sobre TODOS los arenas registrados.
     * @dev O(total arenas registrados). Solo se llama en funciones de owner, no
     *      en un hot path, asi que el coste es irrelevante frente a laSeguridad
     *      que aporta frente a la version hardcodeada.
     */
    function totalReserved() public view returns (uint256 total) {
        for (uint256 i = 0; i < _registeredArenas.length; i++) {
            total += reservedBalance[_registeredArenas[i]];
        }
    }

    /// @notice Arenas con epochs abiertas alguna vez.
    function registeredArenas() external view returns (uint8[] memory) {
        return _registeredArenas;
    }

    // ═══════════════════════════════════════════════════════════
    //  VISTAS
    // ═══════════════════════════════════════════════════════════

    function getEpochInfo(uint8 arena, uint256 epoch) external view returns (
        uint256 pool,
        uint256 positionCount,
        address[] memory winners,
        uint256 totalClaimed,
        uint256 settledAt,
        bool funded,
        bool settled,
        bool canceled
    ) {
        EpochReward storage r = epochRewards[arena][epoch];
        return (
            r.pool, r.positionCount, r.winners, r.totalClaimed, r.settledAt,
            r.funded, r.settled, r.canceled
        );
    }

    function getEpochs(uint8 arena) external view returns (uint256[] memory) {
        return epochList[arena];
    }

    function getWinners(uint8 arena, uint256 epoch) external view returns (address[] memory) {
        return epochRewards[arena][epoch].winners;
    }

    function getPercentages(uint8 arena, uint256 epoch) external view returns (uint256[] memory) {
        return epochRewards[arena][epoch].percentages;
    }

    /// @notice Saldo de una arena sin excluir otras.
    function arenaReserved(uint8 arena) external view returns (uint256) {
        return reservedBalance[arena];
    }
}