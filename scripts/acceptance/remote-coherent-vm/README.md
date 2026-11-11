# Ensayo de restauración de Forge en una VM Windows remota

Este kit conserva Windows Sandbox como origen y ejecuta el destino directamente
en una VM Windows x64 dedicada y descartable. Usa dos bases sintéticas y los
runtimes de la restauración local de la PR #72. La ejecución remota y las
mediciones siguen pendientes.

## Construir el kit desde el repositorio

En un checkout de Forge para Windows x64, instala las dependencias del lockfile
y compila los paquetes. Proporciona un Node 22.23.4 x64 y un directorio local
con los binarios, bibliotecas y extensiones de PostgreSQL 18.4 con pgvector.
El empaquetador copia sólo componentes de ejecución y deja el ZIP y su huella
fuera de Git.

~~~powershell
npm ci
npm run build
New-Item -ItemType Directory -Path .run -Force | Out-Null
$kit = @{
    NodeExe = 'C:\ForgeRuntimes\node.exe'
    PostgresRoot = 'C:\ForgeRuntimes\PostgreSQL\18'
    OutputDirectory = (Join-Path $PWD '.run\vm-kit')
    Zip = $true
}
.\scripts\acceptance\remote-coherent-vm\Build-VmKit.ps1 @kit
~~~

Sustituye las rutas por las de los runtimes de confianza. La carpeta de salida
debe ser nueva. El ZIP resultante y su SHA-256 se generan junto a esa carpeta.

## Preparación

- Usa una VM descartable con disco del sistema NTFS, cuenta de administración
  local y Windows PowerShell 5.1 de 64 bits. La VM debe quedar fuera de dominio.
  Registra un alias para cada máquina y comprueba la independencia física del
  almacenamiento de destino respecto al PC de origen.
- Coteja `vm-kit.zip.sha256` por un canal autenticado. Extrae el kit en una
  carpeta local de confianza. Usa en ambos extremos `input\node.exe Test-Kit.mjs`
  para comprobar los binarios, el manifiesto y la autenticación sintética.
- Prepara acceso por consola de administración y un disco de traspaso dedicado.
  Puedes cargar el kit antes de aislar la VM. La ejecución requiere que la VM
  carezca de rutas IPv4 e IPv6 por defecto. Aísla además la red del origen y de
  producción. El lanzador comprueba las rutas por defecto, mientras que el
  operador comprueba la separación de redes y del almacenamiento. No se cambian
  interfaces ni reglas de red desde el kit.
- Resérvale a la VM `C:\ForgeFixture`, `C:\ForgeFixtureInput`,
  `C:\FixtureInbox` y `C:\FixtureOutput`. El lanzador rechaza rutas existentes.
  El disco de traspaso lleva sólo el material público y la copia cifrada.

## Destino y captura

1. Abre Windows PowerShell elevado en la VM. Genera un UUID para la prueba.
   Puedes añadir `-PlanOnly` para comprobar el kit y los parámetros sin
   crear cuentas, tareas ni rutas.

   ```powershell
   $run = [guid]::NewGuid().ToString()
   .\Start-VmDestination.ps1 -RunId $run -ExpectedComputerName 'FORGE-PREPROD' -ConfirmDisposableVm
   ```

   Sustituye `FORGE-PREPROD` por el nombre de la VM. Mantén abierta la sesión.
   El supervisor temporal de Windows ejecuta la inicialización bajo el custodio
   estándar y prueba el acceso denegado desde otra cuenta estándar. Exporta
   únicamente `C:\FixtureOutput\public.pem`. Coteja `runId` y `recipientSha256`
   de `C:\FixtureOutput\recipient.json` por el canal autenticado. La sesión de
   custodia espera hasta dos horas.

2. En el PC de origen, con Windows Sandbox disponible, ejecuta la captura
   sintética bajo una cuenta de captura estándar del invitado:

   ```powershell
   $capture = @{
       Role = 'Source'
       RunId = $run
       SessionDirectory = 'C:\ForgePreprod\remote-source'
       PublicKey = $receivedPublicPem
       RecipientSha256 = $confirmedRecipientSha256
   }
   .\Start-Rehearsal.ps1 @capture
   ```

   El directorio de sesión debe ser nuevo y su padre debe existir en NTFS.
   El origen cifra los dos volcados, el informe y su identidad, conserva el
   sobre RSA y elimina el clúster y los originales descartables. Exige salida
   0, `outbox\result.json` correcto y `cleanup.json` con el invitado cerrado.

## Traspaso y restauración

1. Copia sólo `outbox\handoff` del origen a `C:\FixtureInbox\handoff` de la
   VM. Coteja `manifestSha256` de `transfer.json` por un canal independiente.
   Mantén la copia local sin escrituras concurrentes. Desmonta el disco de
   traspaso y confirma que la VM no puede acceder al origen. El custodio vuelve
   a verificar el manifiesto y autentica los cuatro componentes antes de
   aprovisionar el PostgreSQL loopback del destino.
2. En otra consola elevada de la VM, valida primero los bytes recibidos:

   ```powershell
   .\Submit-VmReplica.ps1 -RunId $run -ManifestSha256 $confirmedManifestSha256 -VerifyOnly
   ```

3. Declara la pérdida simulada con la réplica ya depositada y mide el RTO
   desde un único observador. Envía la orden de restauración:

   ```powershell
   $rto = [Diagnostics.Stopwatch]::StartNew()
   .\Submit-VmReplica.ps1 -RunId $run -ManifestSha256 $confirmedManifestSha256
   ```

4. Exige salida 0 del lanzador y un `result.json` correcto en
   `C:\FixtureOutput`. La cuenta custodio debe conservar la misma SID en
   creación, restauración y retirada de la clave. Comprueba cuatro componentes
   autenticados, dos salidas 0 de `pg_restore.exe`, roles limitados, siete hashes
   de tablas, recibo e informe, marcador poscorte ausente y una reconciliación
   sin llamadas al agente. El fixture carece de proveedor externo.
5. Registra en `acta.md` el RTO observado y el RPO simulado
   `simulatedRpoMs` que emitió el origen. Comprueba `privateRemoved`,
   `accountsRemoved` y la retirada de la tarea propia. Conserva únicamente
   evidencias sanitizadas y descarta la VM y su disco al acabar. Si se pierde la
   sesión del supervisor o falta la evidencia de limpieza, registra el intento
   como incompleto y descarta la VM y su disco antes de repetir con otro UUID.
