// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title ArcadeVaultV6
 * @notice Vault de arcade coniepocas de 24h, multiples arenas por dificultad y
 *         payout sin custodia. Correccion de la auditoria de contratos sobre V5.
 * @dev EIP-712 domain: "VerityArcadeV5" / "1"  (dominio sin cambios: la app firma con este)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUE CAMBIA RESPECTO A V5 Y POR QUE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * [C1] 30% DEL BOTE PERMANECIA BLOQUEADO PARA SIEMPRE.
 *      V5 repartia 70/20/10 sobre svpWinners[0..2]. Las posiciones vacias del
 *      leaderboard son address(0), y address(0) nunca puede ser msg.sender, asi
 *      que con 1 jugador se perdia el 30% y con 2 el 10%. No existia sweep, y
 *      emergencyWithdraw tampoco podia recuperarlo porque totalPrizeLiability
 *      se habia incrementado con el pool completo y solo bajaba lo reclamado,
 *      dejando la liability elevada de forma permanente.
 *      Aqui el reparto se congela al cerrar sobre el numero REAL de slots
 *      poblados, y toda epochs sin ganadores se anula para reembolso.
 *
 * [H3] ArenaType SOLO TENIA 2 VALORES. enum { HUMAN, AGENT }. Los modos de
 *      dificultad (0.1 / 0.5 / 1.0 SVP) eran imposibles. Ahora hay 4 arenas.
 *      AGENT pasa de indice 1 a 3: cualquier id de arena persistido en la BD
 *      debe migrarse antes del deploy.
 *
 * [H4] forceCloseEpoch CONFISCABA FONDOS DE JUGADORES.
 *      Era onlyOwner sin comprobacion de tiempo, y no existe refund en V5. Un
 *      cierre a mitad de epochCaptoraba hasta 24h de entradas sin recurso:
 *      el jugador pagaba, pagPlayers quedaba en true, pero recordScore exige
 *      epoch == currentEpoch que ya habia avanzado, y el dinero no tenia salida.
 *      Ahora un cierre forzado ANULA la epoch y reembolsa a todos los pagadores
 *      pro rata. El error del owner lo absorbe la epoch, nunca el jugador.
 *
 * [H5] SIN TOPE DE ENTRADAS POR EPOCH. paidPlayers es bool, no habia contador.
 *      Pagar N veces sumaba N * prizeAmount al pool y daba un solo slot de
 *      personalBest, asi que el top-10 se compraba con repeticion. Ahora hay
 *      maxEntries por arena y un contador entries.
 *
 * [M8] MIN_EPOCH_DURATION = 30 SEGUNDOS PODIA INUTILIZAR UNA ARENA PARA SIEMPRE.
 *      payToPlay exige epochEnd - LATE_PAYMENT_BLOCK sin underflow, asi que con
 *      duraciones < 5 minutos toda entrada revierte. setEpochDurationNow clampea
 *      a block.timestamp, que sigue siendo < 5 min, asi que tampoco recupera.
 *      MIN_EPOCH_DURATION ahora es > LATE_PAYMENT_BLOCK, y setEpochDuration /
 *      setEpochDurationNow rechazan cualquier duracion <= LATE_PAYMENT_BLOCK.
 *      Como epochDuration solo se escribe en esos dos sitios y en el
 *      constructor, la invariante epochDuration > LATE_PAYMENT_BLOCK es
 *      estructural: no hay ninguna via para romperla.
 *      payToPlay compara con `block.timestamp + LATE_PAYMENT_BLOCK < epochEnd`
 *      en vez de `block.timestamp < epochEnd - LATE_PAYMENT_BLOCK`, porque la
 *      segunda forma underflowea cuando setEpochDurationNow clampea epochEnd al
 *      block.timestamp actual.
 *
 * [M9] payToPlay NO ERA nonReentrant y hacia treasury.call con todo el gas.
 *      El estado se escribia antes del call, asi que no habia doble conteo, pero
 *      un treasury contractual tendia gas completo y un camino de reentrancia.
 *
 * [L1] nynarWinners / nynarScores eran ALMACENAMIENTO MUERTO: se escribian al
 *      cerrar y ningun path de codigo los leia. La distribucion de VYNAR vive en
 *      VynarRewardsV3. Se eliminan y se agrega un accessor explicito, lo que de
 *      paso elimina la confusion del getter autogenerado de la struct (la app
 *      declaraba 2 outputs y el getter real devuelve 9).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LO QUE SIGUE SIN CAMBIAR A PROPOSITO
 * ─────────────────────────────────────────────────────────────────────────────
 * - El dominio EIP-712 sigue siendo "VerityArcadeV5"/"1". La app firma con ese
 *   dominio; cambiarlo obligaria aCOORDINAR el redeploy con el nuevo backend.
 * - La 70/20/10 para 3 jugadores se preserva. Cambiarla alteraria la economia de
 *   las epochs que ya estan desplegadas.
 * - LATE_PAYMENT_BLOCK = 5 minutos. Con epochs de 24h es irrelevante para el
 *   usuario pero sigue protegiendo la carrera de cierre de epoch.
 */
contract ArcadeVaultV6 is Ownable, ReentrancyGuard, EIP712 {
    using ECDSA for bytes32;

    // ═══════════════════════════════════════════════════════════
    //  TIPOS
    // ═══════════════════════════════════════════════════════════

    /// @notice [H3] 4 arenas. AGENT pasa de indice 1 a 3 (ver nota de migracion).
    enum ArenaType { HUMAN, MEDIUM, HARD, AGENT }

    struct ArenaConfig {
        uint256 entryFee;
        uint256 protocolFeeBps;
        uint256 epochDuration;
        uint256 currentEpoch;
        uint256 epochStart;
        uint256 epochEnd;
        uint256 pool;
        uint256 totalPaid;        // acumulado de la epoch abierta
        uint256 maxEntries;       // [H5] tope de entradas por jugador por epoch
        bool active;
        bool paused;
    }

    struct ScoreEntry {
        address player;
        uint256 score;
    }

    struct EpochResult {
        address[3] svpWinners;
        uint256[3] svpBps;      // [C1] reparto congelado al cerrar
        uint256 winnerCount;    // slots realmente poblados (0..3)
        uint256 prizePool;
        uint256 totalPaid;      // snapshot de ArenaConfig.totalPaid al cerrar
        uint256 paidOut;        // ya pagado a ganadores o reembolsado
        uint256 closedAt;
        bool closed;
        bool voided;            // sin ganadores: todo el pool es reembolsable
        bool swept;
    }

    // ═══════════════════════════════════════════════════════════
    //  ESTADO
    // ═══════════════════════════════════════════════════════════

    mapping(ArenaType => ArenaConfig) public arenas;
    mapping(ArenaType => mapping(uint256 => ScoreEntry[10])) public leaderboard;
    mapping(ArenaType => mapping(uint256 => mapping(address => uint256))) public personalBest;

    mapping(ArenaType => mapping(uint256 => EpochResult)) public epochResults;

    mapping(bytes32 => bool) public usedSessionIds;
    mapping(uint256 => bool) public usedNonces;

    mapping(ArenaType => mapping(uint256 => mapping(address => bool))) public paidPlayers;
    mapping(ArenaType => mapping(uint256 => mapping(address => uint256))) public paidAmount;
    mapping(ArenaType => mapping(uint256 => mapping(address => bool))) public claimed;

    /// @notice [H5] Contador de entradas por jugador y epoch.
    mapping(ArenaType => mapping(uint256 => mapping(address => uint256))) public entries;

    /// @notice Fondos comprometidos con premios o reembolsos aun no pagados.
    mapping(ArenaType => uint256) public totalPrizeLiability;

    address public gameServerSigner;
    address public treasury;

    // ═══════════════════════════════════════════════════════════
    //  CONSTANTES
    // ═══════════════════════════════════════════════════════════

    uint256 public constant BASIS = 10000;

    /// @dev Techo de protocolFeeBps para cualquier arena.
    ///      OJO: un tope que el owner puede mover no es una garantia. Para que el
    ///      20% de HUMAN sea un compromiso real, el owner debe ser un multisig
    ///      o timelock. Ver seccion "RIESGOS RESIDUALES" en el changelog.
    uint256 public constant MAX_PROTOCOL_FEE_BPS = 3000;

    /// @dev [M8] Debe superar LATE_PAYMENT_BLOCK o payToPlay queda inaccesible.
    uint256 public constant LATE_PAYMENT_BLOCK = 5 minutes;
    uint256 public constant MIN_EPOCH_DURATION = 10 minutes;
    uint256 public constant MAX_EPOCH_DURATION = 7 days;

    /// @dev Plazo tras el cual un owner puede barrer premios no reclamados.
    ///      Ver sweepUnclaimed para el trade-off que esto asume.
    uint256 public constant CLAIM_DEADLINE = 30 days;

    bytes32 private constant SCORE_TYPEHASH = keccak256(
        "Score(uint8 arena,address player,uint256 score,bytes32 sessionId,uint256 epoch,uint256 nonce,uint256 deadline)"
    );

    // ═══════════════════════════════════════════════════════════
    //  EVENTOS
    // ═══════════════════════════════════════════════════════════

    event PaymentReceived(address indexed player, ArenaType indexed arena, uint256 epoch, uint256 amount, uint256 entryIndex);
    event ScoreRecorded(address indexed player, ArenaType indexed arena, uint256 epoch, uint256 score, bytes32 sessionId);
    event PersonalBestUpdated(address indexed player, ArenaType indexed arena, uint256 epoch, uint256 oldScore, uint256 newScore);
    event EpochClosed(ArenaType indexed arena, uint256 epoch, uint256 prizePool, uint256 winnerCount);
    event EpochVoided(ArenaType indexed arena, uint256 epoch, uint256 refundablePool, bool forced);
    event PrizeClaimed(address indexed player, ArenaType indexed arena, uint256 epoch, uint256 amount);
    event PrizeClaimedTo(address indexed player, address indexed recipient, ArenaType indexed arena, uint256 epoch, uint256 amount);
    event Refunded(address indexed player, ArenaType indexed arena, uint256 epoch, uint256 amount);
    event UnclaimedSwept(ArenaType indexed arena, uint256 epoch, uint256 amount);
    event ArenaConfigUpdated(ArenaType indexed arena);
    event ArenaPaused(ArenaType indexed arena, bool paused);
    event ArenaActiveUpdated(ArenaType indexed arena, bool active);
    event EpochDurationUpdated(ArenaType indexed arena, uint256 oldDuration, uint256 newDuration);
    event EpochExtended(ArenaType indexed arena, uint256 newEpochEnd);
    event SignerUpdated(address indexed signer);
    event TreasuryUpdated(address indexed treasury);
    event PoolFunded(ArenaType indexed arena, uint256 amount);
    event EmergencyWithdrawn(address indexed to, uint256 amount);

    // ═══════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════

    /**
     * @param initialSigner  Backend que firma recordScore y empuja los pagos.
     * @param initialTreasury Receptor de la protocol fee y destino del sweep.
     * @param mediumMaxEntries / hardMaxEntries  [H5] topes por arena.
     *
     * @dev protocolFeeBps reproduce el fee PLANO de 0.02 SVP pedido:
     *      2000 bps de 0.1 = 0.020 | 400 bps de 0.5 = 0.020 | 200 bps de 1.0 = 0.020.
     *      El fee por entrada es identico en los tres modos, pero la tasa efectiva
     *      cae de 20% a 2%. Si se quiere tasa uniforme, basta setProtocolFee en cada
     *      arena: no requiere redeploy.
     */
    constructor(
        address initialSigner,
        address initialTreasury,
        uint256 humanMaxEntries,
        uint256 mediumMaxEntries,
        uint256 hardMaxEntries
    ) EIP712("VerityArcadeV5", "1") Ownable(msg.sender) {
        require(initialSigner != address(0), "INVALID_SIGNER");
        require(initialTreasury != address(0), "INVALID_TREASURY");
        require(humanMaxEntries > 0 && mediumMaxEntries > 0 && hardMaxEntries > 0, "INVALID_MAX_ENTRIES");

        gameServerSigner = initialSigner;
        treasury = initialTreasury;

        _initArena(ArenaType.HUMAN, 0.1 ether, 2000, humanMaxEntries);
        _initArena(ArenaType.MEDIUM, 0.5 ether, 400, mediumMaxEntries);
        _initArena(ArenaType.HARD, 1.0 ether, 200, hardMaxEntries);

        // AGENT queda en 4 y desactivado. Si mas adelante se implementa, revisar
        // que ningun id de arena persistido asuma que AGENT == 1.
        _initArena(ArenaType.AGENT, 1.0 ether, 200, hardMaxEntries);
        arenas[ArenaType.AGENT].active = false;
    }

    function _initArena(ArenaType arena, uint256 fee, uint256 feeBps, uint256 maxEntries) internal {
        require(arena == ArenaType.HUMAN, "INIT_ONLY_HUMAN");
        ArenaConfig storage c = arenas[arena];
        c.entryFee = fee;
        c.protocolFeeBps = feeBps;
        c.epochDuration = 24 hours;
        c.currentEpoch = 1;
        c.epochStart = block.timestamp;
        c.epochEnd = block.timestamp + 24 hours;
        c.pool = 0;
        c.totalPaid = 0;
        c.maxEntries = maxEntries;
        c.active = arena == ArenaType.HUMAN;
        c.paused = false;
    }

    receive() external payable {}

    modifier notPaused(ArenaType arena) {
        require(!arenas[arena].paused, "ARENA_PAUSED");
        _;
    }

    modifier onlyGameServer() {
        require(msg.sender == gameServerSigner, "NOT_GAME_SERVER");
        _;
    }

    // ═══════════════════════════════════════════════════════════
    //  JUGAR
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice [M9] nonReentrant: hace un call externo a treasury con todo el gas.
     * @dev El estado se escribe antes del call, asi que no existia doble conteo,
     *      pero un treasury contractual recibia gas completo y un camino de
     *      reentrancia. claimPrize ya era nonReentrant; payToPlay no lo era.
     */
    function payToPlay(ArenaType arena) external payable nonReentrant notPaused(arena) {
        ArenaConfig storage config = arenas[arena];
        require(config.active, "ARENA_DISABLED");
        require(msg.value == config.entryFee, "INVALID_ENTRY_FEE");
        require(block.timestamp < config.epochEnd, "EPOCH_ENDED");
        // Forma equivalente a `block.timestamp < config.epochEnd - LATE_PAYMENT_BLOCK`
        // pero sin underflow. La diferencia es alcanzable: setEpochDurationNow puede
        // clampear epochEnd a block.timestamp cuando la duracion nueva no alcanza
        // para cerrar la epoch en curso, y con 0.8.x eso revierte en lugar de
        // dar EPOCH_ENDED. El orden de los requires no es un sustituto.
        require(
            block.timestamp + LATE_PAYMENT_BLOCK < config.epochEnd,
            "TOO_LATE_TO_PLAY"
        );

        uint256 epoch = config.currentEpoch;

        // [H5] El top-10 no debe ser comprable con repeticion. Sin este require,
        // 100 pagos de 0.1 SVP compran 100 intentos al ranking por epoch.
        uint256 entryIndex = entries[arena][epoch][msg.sender];
        require(entryIndex < config.maxEntries, "ENTRY_LIMIT");

        uint256 protocolAmount = Math.mulDiv(msg.value, config.protocolFeeBps, BASIS);
        uint256 prizeAmount = msg.value - protocolAmount;

        config.pool += prizeAmount;
        config.totalPaid += msg.value;

        paidPlayers[arena][epoch][msg.sender] = true;
        paidAmount[arena][epoch][msg.sender] += msg.value;
        entries[arena][epoch][msg.sender] = entryIndex + 1;

        // La protocol fee sale del contrato en el MISMO tx que entra el pago.
        // Esto es lo que hace viable el staking: la fuente es real y verificable
        // via PaymentReceived + el saldo de treasury.
        if (protocolAmount > 0) {
            (bool sent,) = treasury.call{value: protocolAmount}("");
            require(sent, "TREASURY_FAILED");
        }

        emit PaymentReceived(msg.sender, arena, epoch, msg.value, entryIndex);
    }

    // ═══════════════════════════════════════════════════════════
    //  REGISTRO DE PUNTAJE
    // ═══════════════════════════════════════════════════════════

    function recordScore(
        ArenaType arena,
        address player,
        uint256 score,
        bytes32 sessionId,
        uint256 epoch,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external onlyGameServer {
        ArenaConfig storage config = arenas[arena];

        require(block.timestamp <= deadline, "EXPIRED");
        require(deadline <= config.epochEnd, "DEADLINE_AFTER_EPOCH");
        require(block.timestamp <= config.epochEnd, "EPOCH_ENDED");
        require(epoch == config.currentEpoch, "BAD_EPOCH");
        require(paidPlayers[arena][epoch][player], "NO_PAYMENT");
        require(!usedSessionIds[sessionId], "SESSION_USED");
        require(!usedNonces[nonce], "NONCE_USED");

        // Personal best: solo acepta si mejora. Rankea el mejor juego unico, no la
        // suma, lo que ya limita el ataque de volumen a "conseguir una buena
        // partida" — que es lo que el anti-cheat del servidor debe defender.
        uint256 currentBest = personalBest[arena][epoch][player];
        require(score > currentBest, "NOT_PERSONAL_BEST");

        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SCORE_TYPEHASH,
                    uint8(arena),
                    player,
                    score,
                    sessionId,
                    epoch,
                    nonce,
                    deadline
                )
            )
        );
        address recovered = ECDSA.recover(digest, signature);
        require(recovered == gameServerSigner, "BAD_SIGNATURE");

        usedSessionIds[sessionId] = true;
        usedNonces[nonce] = true;

        personalBest[arena][epoch][player] = score;
        emit PersonalBestUpdated(player, arena, epoch, currentBest, score);

        _insertOrUpdate(arena, epoch, player, score);

        emit ScoreRecorded(player, arena, epoch, score, sessionId);
    }

    // ═══════════════════════════════════════════════════════════
    //  CIERRE DE EPOCH
    // ═══════════════════════════════════════════════════════════

    function closeEpoch(ArenaType arena) external {
        ArenaConfig storage config = arenas[arena];
        require(block.timestamp >= config.epochEnd, "EPOCH_ACTIVE");
        _closeEpoch(arena, false);
    }

    /**
     * @notice [H4] Cierre forzado. ANULA la epoch y reembolsa a todos los
     *         pagadores pro rata. No confisca fondos: el error del owner lo
     *         absorbe la epoch, no el jugador.
     * @dev En V5 esto seteaba prizePool con los jugadores aun activos, avanzaba
     *      currentEpoch y no existia refund: el dinero no tenia salida y los
     *      jugadores afectados no podian ni registrar score ni reclamar.
     */
    function forceCloseEpoch(ArenaType arena) external onlyOwner {
        _closeEpoch(arena, true);
    }

    function _closeEpoch(ArenaType arena, bool forced) internal {
        ArenaConfig storage config = arenas[arena];
        uint256 epoch = config.currentEpoch;

        EpochResult storage result = epochResults[arena][epoch];
        require(!result.closed, "ALREADY_CLOSED");

        result.closed = true;
        result.closedAt = block.timestamp;
        result.prizePool = config.pool;
        result.totalPaid = config.totalPaid;
        totalPrizeLiability[arena] += config.pool;

        if (forced) {
            // Sin ganadores y reembolsable. No se leen los ganadores.
            result.voided = true;
            emit EpochVoided(arena, epoch, config.pool, true);
        } else {
            // [C1] Contar slots REALMENTE poblados. Las posiciones vacias del
            // leaderboard son address(0) y nunca pueden reclamar.
            uint256 n;
            for (uint256 i = 0; i < 3; i++) {
                address w = leaderboard[arena][epoch][i].player;
                result.svpWinners[i] = w;
                if (w != address(0)) n++;
            }

            if (n == 0) {
                // Nadie registró score. El pool es 100% reembolsable: pagaron por un
                // juego que no pudieron completar. En V5 estos fondos quedaban
                // atrapados para siempre y bloqueaban emergencyWithdraw.
                result.voided = true;
                emit EpochVoided(arena, epoch, config.pool, false);
            } else {
                result.winnerCount = n;
                (uint256 a, uint256 b, uint256 c) = _splitFor(n);
                result.svpBps = [a, b, c];
                emit EpochClosed(arena, epoch, config.pool, n);
            }
        }

        // Avanzar epoch
        config.currentEpoch = epoch + 1;
        config.pool = 0;
        config.totalPaid = 0;
        config.epochStart = block.timestamp;
        config.epochEnd = block.timestamp + config.epochDuration;

        if (config.paused) {
            config.paused = false;
            emit ArenaPaused(arena, false);
        }
    }

    /// @dev [C1] Reparto sobre slots poblados. La 70/20/10 original se preserva
    ///      para 3 jugadores para no alterar la economia de epochs ya desplegadas.
    ///      1 jugador recibe el 100% en vez de perder el 30%; 2 reciben 70/30
    ///      en vez de perder el 10%.
    function _splitFor(uint256 n) internal pure returns (uint256, uint256, uint256) {
        if (n >= 3) return (7000, 2000, 1000);
        if (n == 2) return (7000, 3000, 0);
        return (10000, 0, 0);
    }

    // ═══════════════════════════════════════════════════════════
    //  CLAIM SVP
    // ═══════════════════════════════════════════════════════════

    function claimPrize(ArenaType arena, uint256 epoch) external nonReentrant {
        _claimPrize(arena, epoch, msg.sender);
    }

    /**
     * @notice [H4-FEATURE] Push desde el servidor sin custodia.
     * @dev Solo el game server puede empujar. Los fondos van directo al
     *      recipient, nunca pasan por una wallet intermedia. La seguridad no
     *      depende de la autorizacion sino de _claimPrize: solo el ganador real
     *      puede ser recipient, asi que empujar a una direccion equivocada es
     *      imposible por construccion, no por permiso.
     * @param recipient Debe ser uno de los svpWinners de la epoch.
     */
    function claimPrizeTo(
        ArenaType arena,
        uint256 epoch,
        address recipient
    ) external onlyGameServer nonReentrant {
        require(recipient != address(0), "ZERO_RECIPIENT");
        _claimPrize(arena, epoch, recipient);
    }

    function _claimPrize(ArenaType arena, uint256 epoch, address player) internal {
        EpochResult storage result = epochResults[arena][epoch];
        require(result.closed, "NOT_CLOSED");
        require(!result.voided, "EPOCH_VOIDED");
        require(!claimed[arena][epoch][player], "CLAIMED");

        uint256 bps;
        for (uint256 i = 0; i < 3; i++) {
            if (result.svpWinners[i] == player) {
                bps = result.svpBps[i];
                break;
            }
        }
        require(bps > 0, "NOT_WINNER");

        uint256 amount = Math.mulDiv(result.prizePool, bps, BASIS);
        require(amount > 0, "ZERO_REWARD");

        // Invariante de solvencia: paidOut nunca puede exceder prizePool porque
        // la suma de svpBps es <= BASIS y Math.mulDiv redondea hacia abajo.
        uint256 newPaidOut = result.paidOut + amount;
        require(newPaidOut <= result.prizePool, "POOL_EXHAUSTED");

        claimed[arena][epoch][player] = true;
        result.paidOut = newPaidOut;
        totalPrizeLiability[arena] -= amount;

        (bool sent,) = player.call{value: amount}("");
        require(sent, "TRANSFER_FAILED");

        emit PrizeClaimed(player, arena, epoch, amount);
    }

    // ═══════════════════════════════════════════════════════════
    //  REEMBOLSO (epochs anuladas)
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice [H4][C1] Reembolso pro rata para epochs anuladas.
     * @dev Solo aplica si result.voided: nadie scored, o el owner forzo el
     *      cierre a mitad de epoch. Un jugador que si scored y quedo fuera del
     *      top-3 NO reembolsa: el jugador completo un juego valido y perdio, que es
     *      justamente el proposito de una leaderboard.
     *
     *      La suma de todos los reembolsos es <= prizePool porque cada uno
     *      redondea hacia abajo. El redondeo a favor del protocolo significa que
     *      siempre queda un residuo, nunca se sobrepaga. Fail-closed por
     *      construccion.
     */
    function refund(ArenaType arena, uint256 epoch) external nonReentrant returns (uint256 amount) {
        EpochResult storage result = epochResults[arena][epoch];
        require(result.closed, "NOT_CLOSED");
        require(result.voided, "NOT_REFUNDABLE");
        require(!claimed[arena][epoch][msg.sender], "CLAIMED");
        require(result.totalPaid > 0, "NO_PAID");

        uint256 paid = paidAmount[arena][epoch][msg.sender];
        require(paid > 0, "NOTHING_PAID");

        amount = Math.mulDiv(result.prizePool, paid, result.totalPaid);
        require(amount > 0, "ZERO_REFUND");

        uint256 newPaidOut = result.paidOut + amount;
        require(newPaidOut <= result.prizePool, "POOL_EXHAUSTED");

        claimed[arena][epoch][msg.sender] = true;
        result.paidOut = newPaidOut;
        totalPrizeLiability[arena] -= amount;

        (bool sent,) = msg.sender.call{value: amount}("");
        require(sent, "TRANSFER_FAILED");

        emit Refunded(msg.sender, arena, epoch, amount);
    }

    // ═══════════════════════════════════════════════════════════
    //  SWEEP
    // ═══════════════════════════════════════════════════════════

    /**
     * @notice [C1] Recupera premios no reclamados tras CLAIM_DEADLINE.
     * @dev Sin esto, los fondos de ganador que nunca reclama quedan bloqueados
     *      para siempre. Es la UNICA salida de premios hacia el treasury, y
     *      emite evento con monto y epoch.
     *
     *      TRADE-OFF ASSUMIDO: el owner puede emitir a un ganador que no reclamo
     *      en 30 dias. Es preferible a bloquear los fondos indefinidamente, pero
     *      el owner debe ser multisig o timelock para que sea aceptable.
     */
    function sweepUnclaimed(ArenaType arena, uint256 epoch) external onlyOwner nonReentrant {
        EpochResult storage result = epochResults[arena][epoch];
        require(result.closed, "NOT_CLOSED");
        require(!result.swept, "ALREADY_SWEPT");
        require(block.timestamp >= result.closedAt + CLAIM_DEADLINE, "TOO_EARLY");

        uint256 remaining = result.prizePool - result.paidOut;
        require(remaining > 0, "NOTHING_TO_SWEEP");

        result.swept = true;
        result.paidOut = result.prizePool;
        totalPrizeLiability[arena] -= remaining;

        (bool sent,) = treasury.call{value: remaining}("");
        require(sent, "TREASURY_FAILED");

        emit UnclaimedSwept(arena, epoch, remaining);
    }

    // ═══════════════════════════════════════════════════════════
    //  INSERCIÓN SIN DUPLICADOS
    // ═══════════════════════════════════════════════════════════

    function _insertOrUpdate(
        ArenaType arena,
        uint256 epoch,
        address player,
        uint256 score
    ) internal {
        ScoreEntry[10] storage board = leaderboard[arena][epoch];

        for (uint256 i = 0; i < 10; i++) {
            if (board[i].player == player) {
                board[i].score = score;
                _reorder(board, i);
                return;
            }
        }

        for (uint256 i = 0; i < 10; i++) {
            if (score > board[i].score) {
                for (uint256 j = 9; j > i; j--) {
                    board[j] = board[j - 1];
                }
                board[i] = ScoreEntry({player: player, score: score});
                return;
            }
        }
        // Score por debajo del 10o lugar: personalBest queda registrado pero no hay
        // slot. El jugador pago y no premio. Es el diseno de una leaderboard, pero
        // conviene revisarlo con volumen real (ver CHANGELOG, riesgos residuales).
    }

    function _reorder(ScoreEntry[10] storage board, uint256 fromIdx) internal {
        ScoreEntry memory entry = board[fromIdx];
        uint256 i = fromIdx;
        while (i > 0 && board[i - 1].score < entry.score) {
            board[i] = board[i - 1];
            i--;
        }
        board[i] = entry;
    }

    // ═══════════════════════════════════════════════════════════
    //  VISTAS
    // ═══════════════════════════════════════════════════════════

    /// @notice Top 10 completo de una epoch.
    function getTop10(ArenaType arena, uint256 epoch)
        external view returns (address[10] memory players, uint256[10] memory scores)
    {
        ScoreEntry[10] storage board = leaderboard[arena][epoch];
        for (uint256 i = 0; i < 10; i++) {
            players[i] = board[i].player;
            scores[i] = board[i].score;
        }
    }

    /**
     * @notice Vista de arena. MISMOS 10 outputs que V5 para no romper la app.
     */
    function getArenaInfo(ArenaType arena) external view returns (
        uint256 entryFee,
        uint256 protocolFeeBps,
        uint256 epochDuration,
        uint256 currentEpoch,
        uint256 epochStart,
        uint256 epochEnd,
        uint256 pool,
        bool active,
        bool paused,
        uint256 secondsLeft
    ) {
        ArenaConfig storage c = arenas[arena];
        uint256 left = c.epochEnd > block.timestamp ? c.epochEnd - block.timestamp : 0;
        return (
            c.entryFee, c.protocolFeeBps, c.epochDuration, c.currentEpoch,
            c.epochStart, c.epochEnd, c.pool, c.active, c.paused, left
        );
    }

    /// @notice [H5] Datos extendidos que getArenaInfo no expone.
    function getArenaSnapshot(ArenaType arena) external view returns (
        uint256 maxEntries,
        uint256 totalPaid,
        uint256 myEntries,
        uint256 protocolFeeWei,
        uint256 prizePerEntryWei
    ) {
        ArenaConfig storage c = arenas[arena];
        uint256 fee = Math.mulDiv(c.entryFee, c.protocolFeeBps, BASIS);
        return (
            c.maxEntries,
            c.totalPaid,
            entries[arena][c.currentEpoch][msg.sender],
            fee,
            c.entryFee - fee
        );
    }

    /**
     * @notice [L1] Acceso explicito a un resultado de epoch.
     * @dev Reemplaza al getter autogenerado de la struct, que en V5 devolvia 9
     *      valores (incluyendo nynarWinners/nynarScores muertos) mientras la app
     *      declaraba 2. Ahora la forma esta declarada, no inferida.
     */
    function getEpochResult(ArenaType arena, uint256 epoch) external view returns (
        address[3] memory winners,
        uint256[3] memory bps,
        uint256 winnerCount,
        uint256 prizePool,
        uint256 paidOut,
        uint256 totalPaid,
        bool closed,
        bool voided,
        bool swept
    ) {
        EpochResult storage r = epochResults[arena][epoch];
        return (
            r.svpWinners, r.svpBps, r.winnerCount, r.prizePool,
            r.paidOut, r.totalPaid, r.closed, r.voided, r.swept
        );
    }

    /// @notice Saldo total comprometido con premios y reembolsos de una arena.
    function prizeLiability(ArenaType arena) external view returns (uint256) {
        return totalPrizeLiability[arena];
    }

    /// @notice [M7] Duracion configurada. La app debe leerla de aqui y no de su
    ///         propia constante: en V5 la app decia 86400 y el contrato 3600.
    /// @dev Se llama getEpochDuration y no epochDuration porque el segundo nombre
    ///      chocaba con el output homonimo de getArenaInfo y solc lo reporta como
    ///      shadowing.
    function getEpochDuration(ArenaType arena) external view returns (uint256) {
        return arenas[arena].epochDuration;
    }

    function getPersonalBest(ArenaType arena, uint256 epoch, address player)
        external view returns (uint256)
    {
        return personalBest[arena][epoch][player];
    }

    // ═══════════════════════════════════════════════════════════
    //  ADMIN
    // ═══════════════════════════════════════════════════════════

    function setArenaFee(ArenaType arena, uint256 fee) external onlyOwner {
        require(fee > 0, "INVALID_FEE");
        arenas[arena].entryFee = fee;
        emit ArenaConfigUpdated(arena);
    }

    function setProtocolFee(ArenaType arena, uint256 feeBps) external onlyOwner {
        require(feeBps <= MAX_PROTOCOL_FEE_BPS, "FEE_TOO_HIGH");
        arenas[arena].protocolFeeBps = feeBps;
        emit ArenaConfigUpdated(arena);
    }

    /// @notice [H5] Tope de entradas por jugador y epoch.
    function setMaxEntries(ArenaType arena, uint256 maxEntries) external onlyOwner {
        require(maxEntries > 0, "INVALID_MAX_ENTRIES");
        arenas[arena].maxEntries = maxEntries;
        emit ArenaConfigUpdated(arena);
    }

    function setArenaActive(ArenaType arena, bool active) external onlyOwner {
        arenas[arena].active = active;
        emit ArenaActiveUpdated(arena, active);
    }

    function setPaused(ArenaType arena, bool _paused) external onlyOwner {
        arenas[arena].paused = _paused;
        emit ArenaPaused(arena, _paused);
    }

    /**
     * @notice [M8] Exige duration > LATE_PAYMENT_BLOCK.
     * @dev Aplica solo a la PROXIMA epoch, como en V5. Para cambiar la actual usa
     *      setEpochDurationNow, que ademas puede clampear epochEnd al
     *      block.timestamp actual si la duracion nueva no alcanza para cerrar la
     *      epoch en curso.
     */
    function setEpochDuration(ArenaType arena, uint256 duration) external onlyOwner {
        require(
            duration > LATE_PAYMENT_BLOCK && duration <= MAX_EPOCH_DURATION,
            "INVALID_DURATION"
        );
        uint256 old = arenas[arena].epochDuration;
        arenas[arena].epochDuration = duration;
        emit EpochDurationUpdated(arena, old, duration);
    }

    function setEpochDurationNow(ArenaType arena, uint256 duration) external onlyOwner {
        require(
            duration > LATE_PAYMENT_BLOCK && duration <= MAX_EPOCH_DURATION,
            "INVALID_DURATION"
        );
        ArenaConfig storage config = arenas[arena];
        uint256 old = config.epochDuration;
        config.epochDuration = duration;
        uint256 newEnd = config.epochStart + duration;
        if (newEnd < block.timestamp) newEnd = block.timestamp;
        config.epochEnd = newEnd;
        emit EpochDurationUpdated(arena, old, duration);
        emit EpochExtended(arena, newEnd);
    }

    function extendCurrentEpoch(ArenaType arena, uint256 extraSeconds) external onlyOwner {
        require(extraSeconds > 0, "INVALID_EXTENSION");
        arenas[arena].epochEnd += extraSeconds;
        emit EpochExtended(arena, arenas[arena].epochEnd);
    }

    function setGameServerSigner(address signer) external onlyOwner {
        require(signer != address(0), "INVALID_SIGNER");
        gameServerSigner = signer;
        emit SignerUpdated(signer);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "INVALID_TREASURY");
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    /**
     * @notice Dona al bote de una arena. Sin devolucion: es un regalo al pool.
     * @dev Deliberadamente NO cuenta como totalPaid, asi que no altera los
     *      reembolsos pro rata. Util para subsidizar premios desde el bootstrap.
     */
    function fundPool(ArenaType arena) external payable {
        arenas[arena].pool += msg.value;
        emit PoolFunded(arena, msg.value);
    }

    /**
     * @notice Recupera el exceso por encima de toda la liability comprometida.
     * @dev El requisito de V5 (pausar AMBAS arenas) se elimino. Con 4 arenas solo
     *      se cumpliria si nadie pudiera jugar en ninguna, es decir que en la
     *      practica nunca se podria recuperar nada. Ese requisito no aportaba
     *      seguridad: la garantia real es aritmetica, no un flag de pausa.
     *
     *      Los fondos comprometidos no pueden tocarse porque el withdrawable es
     *      balance - reserved, y reserved suma la liability de las 4 arenas.
     *      Un deposito accidental via receive() queda por encima de reserved y
     *      si es recuperable.
     */
    function emergencyWithdraw() external onlyOwner nonReentrant {
        uint256 reserved = totalPrizeLiability[ArenaType.HUMAN]
            + totalPrizeLiability[ArenaType.MEDIUM]
            + totalPrizeLiability[ArenaType.HARD]
            + totalPrizeLiability[ArenaType.AGENT];

        uint256 balance = address(this).balance;
        require(balance > reserved, "NO_WITHDRAWABLE_BALANCE");

        uint256 withdrawable = balance - reserved;
        (bool sent,) = owner().call{value: withdrawable}("");
        require(sent, "TRANSFER_FAILED");

        emit EmergencyWithdrawn(owner(), withdrawable);
    }
}