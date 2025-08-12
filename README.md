# Voice Orchestrator

Servicio integrado con ElevenLabs para disparar llamadas telefónicas con soporte para llamadas prioritarias y en cola (hasta 100K llamadas/día).

## Características

- **Llamadas prioritarias**: Endpoint para llamadas inmediatas
- **Llamadas en cola**: Sistema de colas para hasta 100K llamadas/día
- **Multi-tenancy**: Soporte para múltiples workspaces, agentes y números
- **Persistencia**: Almacenamiento de llamadas con Prisma + PostgreSQL
- **Retención de datos**: Limpieza automática cada 15 días + reportes diarios agregados
- **Colas robustas**: BullMQ + Redis para manejo de alto volumen

## Endpoints

### POST /calls/priority
Crear llamada inmediata (on-time)

```json
{
  "workspaceId": "workspace_id",
  "agentId": "agent_id", 
  "agentPhoneNumberId": "phnum_xxx",
  "to": "+34631021622",
  "from": "+34601893170",
  "variables": {
    "businessName": "Restaurante Andres",
    "customerName": "Juan Pérez"
  }
}
```

### POST /calls/bulk
Crear llamadas en cola

```json
{
  "workspaceId": "workspace_id",
  "agentId": "agent_id",
  "agentPhoneNumberId": "phnum_xxx", 
  "from": "+34601893170",
  "calls": [
    {
      "to": "+34631021622",
      "variables": {
        "businessName": "Restaurante Andres",
        "customerName": "Juan Pérez"
      }
    }
  ]
}
```

### GET /calls
Listar llamadas con paginación

### GET /calls/report
Reporte agregado de llamadas por workspace/agente

## Variables de Entorno

```bash
# ElevenLabs
ELEVENLABS_API_KEY=sk_xxx
ELEVENLABS_BASE_URL=https://api.elevenlabs.io
ELEVENLABS_OUTBOUND_CALLS_PATH=/v1/convai/twilio/outbound-call

# Redis
REDIS_URL=redis://xxx

# Base de datos
DATABASE_URL=postgresql://xxx

# Servidor
SERVICE_PORT=3000
CALLS_WORKER_CONCURRENCY=10
RETENTION_DAYS=15
LOG_LEVEL=info
```

## Desarrollo Local

```bash
# Instalar dependencias
npm install

# Generar cliente Prisma
npm run prisma:generate

# Ejecutar migraciones
npm run prisma:migrate

# Desarrollo
npm run dev

# Build
npm run build

# Producción
npm start
```

## Despliegue en Railway

1. **Conectar repositorio**:
   ```bash
   railway login
   railway init
   ```

2. **Configurar variables de entorno**:
   - `ELEVENLABS_API_KEY`
   - `REDIS_URL` 
   - `DATABASE_URL`
   - `ELEVENLABS_BASE_URL`
   - `ELEVENLABS_OUTBOUND_CALLS_PATH`

3. **Desplegar**:
   ```bash
   railway up
   ```

4. **Ejecutar migraciones**:
   ```bash
   railway run npm run prisma:migrate
   ```

## Estructura de Base de Datos

- **Workspace**: Organizaciones/empresas
- **Agent**: Agentes de ElevenLabs por workspace
- **WorkspacePhoneNumber**: Números de teléfono por workspace
- **Campaign**: Campañas de llamadas
- **Call**: Registro de llamadas individuales
- **CallDailyAggregate**: Reportes diarios agregados

## Monitoreo

- **Health check**: `/health`
- **Logs**: Railway dashboard
- **Métricas**: Llamadas por workspace/agente
- **Retención**: Limpieza automática cada 15 días

## Escalabilidad

- **Workers**: Configurable via `CALLS_WORKER_CONCURRENCY`
- **Redis**: Soporte para múltiples instancias
- **Base de datos**: Índices optimizados para consultas por workspace
- **Colas**: BullMQ con prioridades y reintentos
