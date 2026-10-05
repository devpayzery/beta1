# ArcadeVaultV6 / VynarRewardsV3 — notas de migración

Documento de referencia para el redeploy. Los contratos nuevos son
`contracts/ArcadeVaultV6.sol` y `contracts/VynarRewardsV3.sol`.

`contracts/ArcadeVaultV2.sol`, `contracts/VynarDistributor.sol` y `contracts/Vynar.sol`
siguen siendo código muerto: no los toco este cambio y no deben tocarse. El vault que
corre hoy en la cadena es `ArcadeVaultV5`, cuyo Solidity no vive en este repo.

---

## 1. Qué se verificó realmente

| Comprobación | Resultado |
|---|---|
| `solc 0.8.30`, sin optimizer | compila; **29918 bytes → excede el límite de 24576** |
| `solc 0.8.30 --optimize --optimize-runs 200` | compila limpio, sin warnings |
| Tamaño `ArcadeVaultV6` | 19917 bytes (81.0% del límite), margen 4659 |
| Tamaño `VynarRewardsV3` | 12322 bytes (50.1% del límite), margen 12254 |
| `npx eslint .` | 0 |
| `npx tsc --noEmit` | 0 |
| `npx vitest run` | 63/63 |

**El optimizer no es opcional.** Sin él el vault no es desplegable. Si el margen de
4659 bytes se queda corto al añadir funcionalidad, hay que subir `runs` a 1 o mover
lógica a libraries — pero nunca recortando en la contabilidad.

OpenZeppelin 5.6.1 usa `mcopy`, que requiere Cancun. Compilar con solc < 0.8.27 falla.
La cadena destino tiene que soportar Cancun.

**Lo que NO se verificó:** no hay tests Solidity ni cadena de test. La lógica de
reparto, el loop de reinsertion del leaderboard y la contabilidad de `paidOut` están
revisados por lectura, no por ejecución. Antes de poner dinero real detrás, hacen falta
tests Foundry que cubran como minimo: cierre con 1, 2, 3 y 0 jugadores; reembolso
pro rata con redondeo; `POOL_EXHAUSTED` con reintentos; y el invariante
`paidOut <= prizePool` bajo claimants adversariales.

---

## 2. Los 9 bugs y su corrección

| # | Severidad | Bug | Corrección |
|---|---|---|---|
| C1 | crítica | 30% del bote bloqueado para siempre | `svpBps[]` congelado sobre slots poblados al cerrar; epoch sin ganador se anula y reembolsa |
| C2 | crítica | `withdraw` con arenas hardcodeadas (0,1) | `totalReserved()` itera arenas registradas |
| H3 | alta | `enum { HUMAN, AGENT }` — máx 2 modos | `enum { HUMAN, MEDIUM, HARD, AGENT }` |
| H4 | alta | `forceCloseEpoch` confiscaba sin `refund` | cierre forzado anula la epoch y reembolsa pro rata |
| H5 | alta | sin tope de entradas por epoch | `maxEntries` por arena + mapping `entries` |
| M6 | media | `WITHDRAW_DELAY` declarado y nunca aplicado | gate contra `latestSettledAt` |
| M7 | media | duración de app 86400 vs contrato 3600 | `getEpochDuration()` para leer la verdad on-chain |
| M8 | media | `MIN_EPOCH_DURATION = 30s` inutilizaba la arena | `MIN_EPOCH_DURATION = 10 min`; comparación sin underflow |
| M9 | media | `payToPlay` no era `nonReentrant` | `nonReentrant` + llamada a treasury acotada |

M6 y M8 no eran "bugs" sino código muerto: constantes y NatSpec que prometían
garantías que ninguna línea de código ejecutaba.

---

## 3. Cambios de comportamiento que no son bug fixes

Estos alteran la economía. Decisión consciente, no accidente:

- **Reparto 70/20/10 → variable por número de jugadores.** Con 3 jugadores no cambia
  (preservado a propósito, para no invalidar epochs ya desplegadas). Con 1 jugador el
  ganador ahora cobra el 100% en vez de perder el 30%; con 2, 70/30 en vez de perder
  el 10%.
- **`forceCloseEpoch` deja de poder confiscar.** Antes podía tomar hasta 24h de
  entradas sin salida para el jugador. Ahora la epoch se anula y el error lo absorbe la
  epoch.
- **Nueva `refund`.** Solo aplica a epochs anuladas (nadie scoreó, o cierre forzado).
  Quien scoreó y quedó fuera del top-3 **no** reembolsa: completó un juego válido y
  perdió, que es el propósito de una leaderboard.
- **Tope de entradas.** 50 en HUMAN, 20 en MEDIUM, 10 en HARD (constructor;
  ajustables con `setMaxEntries`). Sin esto el top-10 se compraba con repetición.
- **Fee plano de 0.02 SVP reproducido con bps por arena:** HUMAN 2000, MEDIUM 400,
  HARD 200. El monto por entrada es idéntico; la tasa efectiva cae de 20% a 2%. Para
  tasa uniforme, `setProtocolFee` por arena, sin redeploy.

---

## 4. Migración de datos — el punto que más fácilmente se pasa por alto

**`AGENT` cambia de índice: 1 → 3.** En V5 `enum { HUMAN=0, AGENT=1 }`. En V6
`AGENT=3` y `MEDIUM=1`. Cualquier valor persistido como `1` que significara "agent"
ahora significa "medium".

La BD no guarda el índice numérico: `arcade_sessions.arena_type` y
`arcade_scores.arena_type` son **text**. Eso salva los datos, pero el constraint es
`check (arena_type in ('human','agent'))`, así que:

```sql
-- migración obligatoria ANTES de activar MEDIUM/HARD
alter table public.arcade_sessions drop constraint if exists arcade_sessions_arena_type_check;
alter table public.arcade_sessions add constraint arcade_sessions_arena_type_check
  check (arena_type in ('human','medium','hard','agent'));

alter table public.arcade_scores drop constraint if exists arcade_scores_arena_type_check;
alter table public.arcade_scores add constraint arcade_scores_arena_type_check
  check (arena_type in ('human','medium','hard','agent'));
```

Sin esto, el primer score de un modo nuevo revienta el insert.

En el lado TypeScript, `lib/arcade-types.ts:6` declara `ArenaType = 'human' | 'agent'`
y `lib/arcade-vault-v5-abi.ts:4` declara `AGENT_ARENA = 1`. Ambos deben pasar a los
cuatro valores con `HUMAN_ARENA=0, MEDIUM_ARENA=1, HARD_ARENA=2, AGENT_ARENA=3`.

---

## 5. ABI de la app — completado

**Resuelto.** Los cuatro ABI se generan ahora desde los artefactos de solc, porque
escribir 41 firmas a mano es exactamente como se produjo el hueco original.

| Archivo | Antes | Ahora |
|---|---|---|
| `lib/arcade-vault-v5-abi.ts` | 17 fn, 2 eventos | **41 fn, 16 eventos**, 8 errores |
| `lib/vynar-config.ts` → `vynarAbi` | 12 fn, 1 evento | **33 fn, 10 eventos**, 16 errores |
| `lib/vynar-config.ts` → `vynarRewardsV2Abi` | 13 fn, 3 eventos | **28 fn, 9 eventos** |
| `lib/arcade-vault-v6-abi.ts` | — | **50 fn, 20 eventos** (nuevo) |
| `lib/vynar-rewards-v3-abi.ts` | — | **33 fn, 11 eventos** (nuevo) |

Se incluye también `PaymentReceived`, que es como se verifica on-chain que un pago
aterrizó, y `transferWithAuthorization` de VYNAR, sin la cual los boosters por HTTP 402
no se pueden cobrar.

Ningún nombre declarado resultó ser fantasma: los 17 nombres del ABI anterior existen
todos en el contrato real. El problema era omisión, no invención.

El getter autogenerado de `EpochResult` **sí** omite los miembros array de la struct
(`svpWinners`, `nynarWinners`, `nynarScores`), así que devuelve exactamente los 2 que
declaraba la app: `prizePool` y `closed`. Esta entrada era correcta; se verificó
compilando el V5 real y comparando contra el artefacto. V6 tampoco sufre esto: el
acceso es por `getEpochResult()`, con la forma declarada explícitamente.

Al hacer el redeploy, reemplazar el ABI por el generado. Ya está en
`lib/arcade-vault-v6-abi.ts`, junto con `lib/arcade-vault-v5-abi.ts` completo y
`lib/vynar-rewards-v3-abi.ts`. Los tres se generan desde los artefactos de solc, no a
mano: el archivo anterior declaraba 17 de las 41 funciones reales.

### Trampa de migración: `arenas` cambia de forma

El getter `arenas` devuelve **9 outputs en V5 y 11 en V6**. Los índices 0-6 son
idénticos, a partir de ahí se desplaza:

| índice | V5 | V6 |
|---|---|---|
| 0-6 | `entryFee` hasta `pool` | igual |
| 7 | `active` (bool) | `totalPaid` (uint256) |
| 8 | `paused` (bool) | `maxEntries` (uint256) |
| 9 | — | `active` (bool) |
| 10 | — | `paused` (bool) |

El código que lee `arena[7]` esperando un `bool` recibirá un `bigint`. El typecheck lo
detecta si el valor se usa como booleano, pero no si se pasa a una función que acepta
ambos. Para código nuevo usar `getArenaInfo`, cuyos 10 outputs son estables y están
nombrados.

---

## 6. Riesgos residuales que siguen abiertos

Ninguno de estos se resolvió aquí. Son decisiones de producto o de governance.

1. **`sweepUnclaimed` puede emitir a un ganador.** Tras 30 días, el owner se lleva el
   saldo no reclamado de una epoch. Es preferible a bloquear los fondos para siempre,
   y emite `UnclaimedSwept(arena, epoch, amount)`. Aceptable **solo** con owner
   multisig o timelock.

2. **Los top caps no son garantías.** `MAX_PROTOCOL_FEE_BPS = 3000` lo puede cambiar el
   owner. Un tope que el owner puede mover no protege al usuario. Lo que protege es que
   el owner sea un timelock. Si el 20% de HUMAN debe ser un compromiso real, eso se
   resuelve en la governance, no en el código.

3. **El fee plano no escala.** El staker recibe los mismos 0.02 por entrada en los tres
   modos, así que su ingreso **no** escala con el volumen de los modos caros: el bruto
   escala 10× peor en HARD que en HUMAN. Si la meta es maximizes ingreso del staking,
   esto es correcto. Si la meta es que el ingreso crezca con la dificultad, el fee tiene
   que ser proporcional y habría que revisar la decisión de 0.02 plano.

4. **Sin `refund` para quien scoreó y perdió.** Con top-10 pagado y top-3 cobrando,
   la mayoría de los jugadores que pagaron y jugaron bien se van con cero. Es el diseño
   de una leaderboard, pero con volumen real conviene medir la tasa de retención. Si
   molesta, la opción es un reembolso de participación (p. ej. 30% a quien registró
   score válido), owner-settable. No está implementado a propósito: cambia la
   economía del pool yprefiere hacerlo con datos, no con una suposición.

5. **Anti-cheat no es criptográfico.** `gameSeed` llega al cliente. `expectedState(seed,
   tick)` es el siguiente paso y no está tocado.

6. **`openEpoch` no mintea.** El VYNAR debe transferirse al contrato antes. Si
   `openEpoch` falla, los fondos ya están dentro y son recuperables con `withdraw`
   pasado `WITHDRAW_DELAY` — por eso los dos pasos van separados y en ese orden.

7. **El dust nunca gana.** Con un stake tan pequeño que `staked × 13% < 1 wei`, el
   presupuesto diario redondea a cero y ese staker no acumula nunca. No es riesgo de
   solvencia, es una decisión de redondeo a favor del pool. documentado en el contrato.

---

## 6b. `StakingVault` — escrito y verificado

`contracts/StakingVault.sol`, 10123 bytes (41% del límite). ABI en
`lib/staking-vault-abi.ts`. Dos pools: `SVP` (nativo) y `VYNAR` (ERC20).

### El error que este diseño está construido para no cometer

La lectura ingenua de "cobro solo de días completados" es:

```
pending = staked × accPricePerShare × díasTranscurridos
```

`accPricePerShare` es **acumulado desde el inicio del pool**, no por día. Con 100 SVP
staked y un precio que sube de 1.0 a 1.5 en cinco días, un usuario que no toca nada
hasta el día 5 recibiría `100 × 1.5 × 5 = 750`, cuando el pool solo tiene 50. **Se
llevaría 15× el pool entero y lo dejaría insolvente.** El día completo no es un
multiplicador: es una puerta.

La solución: `accPricePerShare` solo avanza cuando un día se cierra (`_closeDays`), y el
accrue es la diferencia contra el precio del último settle del usuario.

```
pending += staked × (accPricePerShare - debtPrice) / 1e18
```

### Sin shares, a propósito

No hay share price. `stakedTotal` contra `rewardReserve`, y `rewardReserve` solo crece
con `notifyReward` / `topUpFromMint`. Eso hace que una donación directa sea
inofensiva: los tokens donados no entran en el reserve, así que ningún staker puede
reclamarlos — solo `rescue`, y solo el owner. Con shares habría que acertar la
aritmética de dilución para llegar al mismo resultado. Menos código, mismo resultado,
un vector menos.

### SVP no se puede mintear

`topUpFromMint` solo existe para VYNAR. El rendimiento de SVP solo puede venir de fees
reales; si el ingreso no alcanza, se detiene. No es una configuración: es una
limitación del activo, y por eso un staker de SVP nunca puede recibir emisión ficticia
sin que nadie lo apruebe.

`topUpFromMint` es explícito y está separado de `notifyReward`, en vez de un mint
automático dentro de `_closeDays`. Así el contrato nunca mintea sin una transacción
deliberada, y `fundingSplit()` mide la proporción real entre ingreso y mint en vez de
estimarla.

### Verificación

La aritmética se comprobó con una simulación en bigints (no con el EVM). Seis
escenarios:

| Escenario | Resultado |
|---|---|
| 1 staker, 5 días sin tocar nada | cobra 65 SVP, **no** los 325 de la fórmula errónea |
| 60 días cobrando a diario | cobrado (780) <= funded (3000) |
| bucle claim→unstake→claim | cerrado por el lock de 1 día |
| entrada tardía a un pool con precio ya subido | arranca en cero, no hereda retroactivo |
| redondeo con 3 wei staked | libera 0, nunca de más, sin perder solvencia |
| `fundingSplit` con 300 fees / 100 mint | 75% / 25% |

**Lo que esto no cubre:** es simulación de la contabilidad, no del EVM. No verifica
reentrancia, orden de transacciones reales ni el comportamiento de `safeTransferFrom`
con tokens que devuelven falso en `transfer`. Eso sigue necesitando Foundry.

### Invariantes que hay que monitorear

`solvency(pool)` devuelve `balance - (stakedTotal + rewardReserve)`. Negativo es pasivo.
Es la única cifra que importa en producción, junto con `fundingSplit`: un pool
financiado al 100% por mint no es un yield, es dilución, y en un dashboard que solo
muestra APR las dos cosas se ven igual.

---

## 6c. `BoosterVault` — escrito y compilado, sin números acordados

`contracts/BoosterVault.sol`, verificado con `pnpm compile:contracts` (solc 0.8.24,
`cancun`, optimizer 200). **No hay ABI en `lib/`, no hay variable de entorno y ninguna
ruta lo llama.** La mitad pura del servidor sí está completa y probada
(`lib/booster-validation.ts`), pero sin esta pieza el jugador no tiene forma de comprar
una unidad, así que `availableBoosterUnits` devuelve siempre 0 y la mecánica es
inalcanzable desde el cliente.

### Por qué existe un contrato y no un ERC20 de boosters

El booster no es un token que el jugador guarda: es una unidad, y lo que se gasta es el
derecho a una ventana de 2x dentro de una partida de 20 a 30 segundos. Emitir un token
transferible significaría que se puede vender, regalar o guardar indefinidamente, y el
precio se fijaría en un mercado secundario que este contrato no puede vigilar. Cobrando
por compra y guardando una fila por unidad en `arcade_booster_units`, el saldo es
exactamente "cuántas ventanas has comprado", que es lo único que `boosterValidationError`
necesita comprobar.

El cobro es EIP-3009 (`transferWithAuthorization`), no una allowance. Para esto no hay
una transacción que el jugador firme antes de comprar: hay una respuesta HTTP 402 con un
desafío que firma en el momento. Una allowance exigiría una tx previa, y con ella un
paso más entre "quiero el booster" y "tengo el booster".

### Los tres saldos, y por qué no se pueden comminglear

| Saldo | A quién pertenece | Sale por | Por qué existe |
|---|---|---|---|
| `unsettledVynar` | al comprador, hasta que se liquida | `refundPurchase` | el cobro on-chain y el `INSERT` en Postgres no son atómicos |
| `stakingRewards` | a los stakers | `routeToStaking` → `notifyRewardVynar` | es ingreso real de fees en VYNAR |
| `treasuryBalance` | al protocolo | `withdrawTreasury` | la parte que se queda el vault |

El primero es el que justifica el contrato. Sin él, una compra cuyo `INSERT` falla deja
VYNAR de un jugador al que no se le concedió ninguna unidad, en un saldo que se reparte
entre stakers y tesorería. Con él, ese dinero es reembolsable al comprador y no puede
contaminar el reparto.

Mezclarlos en un único `balance` obligaría a que cada retirada comprobase de dónde viene
el dinero, y eso es exactamente el tipo de comprobación que se olvida una vez y drena los
fondos de los stakers. Es el mismo motivo por el que `StakingVault` mantiene sus saldos de
booster y de LP fuera de sí mismo. Por eso el `require` de cada salida mira un saldo
distinto.

### El reparto no ocurre al cobrar

`collectPurchase` deja el importe entero en `unsettledVynar`; el 70/30 se aplica en
`settlePurchase`, que es `onlyOwner` y corre **después** de que la base de datos haya
confirmado la unidad. Adelantarlo sería repartir VYNAR de compras que quizá se devuelven.

La consecuencia es que el plazo queda del lado correcto: `settlePurchase` solo es válido
dentro de `SETTLE_WINDOW` (2h) y pasado ese plazo `refundPurchase` devuelve el dinero a
su comprador. Un servidor caído es un contratiempo, no una pérdida de fondos, y recuperarlo
no requiere que nadie intervenga.

### No hay `rescue`, y es una decisión

`StakingVault` sí tiene `rescue`; aquí no. `unsettledVynar` es de un jugador concreto y
`stakingRewards` es de los stakers, así que una función de rescate sería inútil en la
práctica: el owner podría llevarse el dinero de los stakers. Si el VYNAR fuera a la
dirección equivocada por un error de despliegue, la salida es un despliegue nuevo, no un
rescate.

### Lo que sigue pendiente de decidir

`UNIT_PRICE_VYNAR = 25e18`, `STAKING_BPS = 7000` / `TREASURY_BPS = 3000` y los tres plazos
son **propuestas, no valores acordados**. Son internamente coherentes — la suma del reparto
es `BASIS`, `refundPurchase` solo alcanza dinero no liquidado, y la diferencia de redondeo
va a tesorería para que `unsettledVynar` cuadre con el saldo — pero el precio y el 70/30
los eligió quien escribió el contrato. Cambiarlos ahora es una constante; cambiarlos
después del deploy es un despliegue nuevo.

**Y sigue faltando, en este orden:** el ABI en `lib/booster-vault-abi.ts`,
`NEXT_PUBLIC_BOOSTER_VAULT_ADDRESS`, la ruta que devuelve el 402 y recoge la firma
EIP-3009, y el botón de activación en `app/play/page.tsx` declarando
`boosterActivations`. Con el contrato sin cablear, la mecánica existe en el servidor y no
existe para el jugador.

---

## 7. Orden de deploy

1. Migración SQL del constraint de `arena_type` (sección 4).
2. Deploy `VynarRewardsV3(token, signer, owner)`.
3. Deploy `ArcadeVaultV6(signer, treasury, 50, 20, 10)`.
4. Transferir propiedad de ambos a un timelock/multisig.
5. Deploy `StakingVault(vynar, owner)` y `setMinter(...)` si se quiere rendimiento de
   VYNAR con emisión. El pool SVP funciona sin minter: se financia con `notifyRewardSvp`.
6. `Vynar.setMinter(rewardsV3)` — solo si el rewards necesita mintear. Hoy no:
   `openEpoch` exige saldo previo, así que el minteo lo hace el owner y lo transfiere.
7. Actualizar `NEXT_PUBLIC_*_ADDRESS` y reemplazar los ABIs en `lib/`.
8. `setEpochDuration(HUMAN, 86400)` en las tres arenas si el deploy no lo deja ya en 24h
   (el constructor sí pone 24h; el constructor solo activa HUMAN).
9. `setArenaActive(MEDIUM, true)` / `setArenaActive(HARD, true)` cuando la app tenga los
   modos implementados. **No activar antes**: el vault aceptaría pagos de modos que la
   app no sabe jugar.
10. Deploy `BoosterVault(vynar, stakingVault, owner)` (sección 6c). **El `owner` que se le
    pasa debe ser el mismo multisig/timelock que gobierna `StakingVault`, y además hay que
    añadir ese contrato como `owner` de `StakingVault`**: `routeToStaking` llama a
    `notifyRewardVynar`, que sobre `StakingVault` es `onlyOwner`. Sin ese paso el reparto a
    los stakers revierte y `stakingRewards` se queda acumulado sin salida.
11. Fijar `UNIT_PRICE_VYNAR` y `STAKING_BPS` / `TREASURY_BPS` **antes** del deploy, no
    después. Son constantes sin setter, así que cambiarlas más tarde exige un despliegue
    nuevo.

El dominio EIP-712 de V6 sigue siendo `"VerityArcadeV5"` / `"1"`, y el de V3 sigue
siendo `"VynarRewardsV2"` / `"1"`. No es un descuido: la app firma con esos dominios, y
cambiarlos obliga a coordinar el redeploy con el backend. Si se quiere corregir el
nombre, es un cambio conjunto y consciente, no un efecto secundario.