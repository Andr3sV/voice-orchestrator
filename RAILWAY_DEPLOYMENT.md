# 🚀 Despliegue en Railway - Voice Orchestrator

## 📋 Prerrequisitos

1. **Cuenta en Railway**: [railway.app](https://railway.app)
2. **Railway CLI**: `npm install -g @railway/cli`
3. **Repositorio Git**: Este proyecto debe estar en un repositorio Git

## 🔧 Paso 1: Preparar el Proyecto

```bash
# Clonar o navegar al proyecto
cd voice-orchestrator

# Instalar dependencias
npm install

# Verificar que todo compile
npm run build
```

## 🚀 Paso 2: Desplegar en Railway

### Opción A: Script Automático (Recomendado)
```bash
# Ejecutar script de despliegue
./deploy-railway.sh
```

### Opción B: Manual
```bash
# Login en Railway
railway login

# Inicializar proyecto
railway init

# Desplegar
railway up
```

## ⚙️ Paso 3: Configurar Variables de Entorno

En Railway Dashboard → Variables:

```bash
# ElevenLabs
ELEVENLABS_API_KEY=sk_50f150b2f9ea3dbf0cba6deec439f24fdd3ca0f6ed622e59
ELEVENLABS_BASE_URL=https://api.elevenlabs.io
ELEVENLABS_OUTBOUND_CALLS_PATH=/v1/convai/twilio/outbound-call

# Redis (crear servicio Redis en Railway)
REDIS_URL=redis://xxx:xxx@xxx.railway.app:xxx

# Base de datos (tu Supabase actual)
DATABASE_URL=postgresql://postgres:Avieltito123!@db.xynmpcaugbvcdnlwoabe.supabase.co:5432/postgres

# Servidor
SERVICE_PORT=3000
CALLS_WORKER_CONCURRENCY=10
RETENTION_DAYS=15
LOG_LEVEL=info
```

## 🗄️ Paso 4: Crear Servicio Redis en Railway

1. En Railway Dashboard → New Service → Redis
2. Copiar la URL de conexión
3. Pegar en `REDIS_URL`

## 🗃️ Paso 5: Ejecutar Migraciones

```bash
# Ejecutar migraciones en Railway
railway run npm run migrate
```

## ✅ Paso 6: Verificar Despliegue

```bash
# Verificar estado
railway status

# Health check
curl https://tu-app.railway.app/health

# Ver logs
railway logs
```

## 🔍 Monitoreo

- **Health Check**: `/health`
- **Logs**: Railway Dashboard → Logs
- **Métricas**: Railway Dashboard → Metrics
- **Variables**: Railway Dashboard → Variables

## 📊 Escalabilidad

- **Auto-scaling**: Railway escala automáticamente
- **Workers**: Ajustar `CALLS_WORKER_CONCURRENCY`
- **Redis**: Railway maneja la escalabilidad
- **Base de datos**: Supabase maneja la escalabilidad

## 🚨 Troubleshooting

### Error: Build Failed
```bash
# Verificar TypeScript
npm run build

# Verificar dependencias
npm install
```

### Error: Redis Connection
- Verificar `REDIS_URL` en Railway
- Crear servicio Redis si no existe

### Error: Database Connection
- Verificar `DATABASE_URL` en Railway
- Ejecutar migraciones: `railway run npm run migrate`

### Error: ElevenLabs API
- Verificar `ELEVENLABS_API_KEY`
- Verificar `ELEVENLABS_BASE_URL`

## 🔗 URLs de Producción

Una vez desplegado, tu servicio estará disponible en:
```
https://tu-app.railway.app
```

### Endpoints Disponibles:
- `POST /calls/priority` - Llamadas inmediatas
- `POST /calls/bulk` - Llamadas en cola
- `GET /calls` - Listar llamadas
- `GET /calls/report` - Reportes agregados
- `GET /health` - Health check

## 📱 Integración con Ateneai

Tu servicio de Ateneai puede llamar a estos endpoints usando la URL de Railway:

```bash
# Llamada prioritaria
curl -X POST https://tu-app.railway.app/calls/priority \
  -H "Content-Type: application/json" \
  -d '{
    "workspaceId": "workspace_id",
    "agentId": "agent_id",
    "agentPhoneNumberId": "phnum_xxx",
    "to": "+34631021622",
    "from": "+34601893170",
    "variables": {
      "businessName": "Restaurante Andres"
    }
  }'

# Llamadas en cola
curl -X POST https://tu-app.railway.app/calls/bulk \
  -H "Content-Type: application/json" \
  -d '{
    "workspaceId": "workspace_id",
    "agentId": "agent_id",
    "agentPhoneNumberId": "phnum_xxx",
    "from": "+34601893170",
    "calls": [
      {
        "to": "+34631021622",
        "variables": {
          "businessName": "Restaurante Andres"
        }
      }
    ]
  }'
```

## 💰 Costos Estimados

- **Railway**: $5-20/mes (dependiendo del uso)
- **Redis**: Incluido en Railway
- **Supabase**: $25/mes (plan Pro)
- **Total**: ~$30-45/mes

## 🎯 Próximos Pasos

1. ✅ Desplegar en Railway
2. ✅ Configurar variables de entorno
3. ✅ Ejecutar migraciones
4. ✅ Probar endpoints
5. ✅ Integrar con Ateneai
6. 🔄 Monitorear y escalar según necesidad
