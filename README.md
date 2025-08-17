# Voice Orchestrator

Servicio integrado con **ElevenLabs SIP Trunk** y **Twilio AMD Bridge** para llamadas telefónicas inteligentes con detección automática de máquinas contestadoras. Soporte para llamadas prioritarias y en cola (hasta 100K+ llamadas/día).

## 🚀 Características Principales

- **AMD Bridge Híbrido**: Combina ElevenLabs SIP trunk con Twilio AMD detection
- **Llamadas prioritarias**: Endpoint para llamadas inmediatas con personalización completa
- **Llamadas en cola**: Sistema de colas para hasta 100K+ llamadas/día
- **Multi-tenancy**: Soporte para múltiples workspaces, agentes y números
- **Persistencia**: Almacenamiento de llamadas con Prisma + PostgreSQL
- **Retención de datos**: Limpieza automática cada 15 días + reportes diarios agregados
- **Colas robustas**: BullMQ + Redis para manejo de alto volumen
- **Personalización AMD**: Control total sobre machine detection y concurrencia

## 🎯 Sistema Híbrido AMD Bridge

### **Arquitectura:**

- **ElevenLabs SIP Trunk**: Para llamadas reales con Caller ID correcto
- **Twilio AMD**: Solo para detección de máquinas contestadoras
- **Ahorro de costos**: No paga por voicemails (solo por conversaciones reales)

### **Flujo:**

1. **Llamada se origina** vía ElevenLabs SIP trunk
2. **Twilio detecta** si es humano o máquina contestadora
3. **Si es humano**: Se conecta la llamada ya creada en ElevenLabs
4. **Si es máquina**: Se cuelga automáticamente (0 costo)

## 📡 Endpoints de la API

### **POST /calls/priority** - Llamada Inmediata

Crear llamada de alta prioridad con personalización completa de AMD.

#### **Headers requeridos:**

```http
Authorization: Bearer <API_KEY>
x-gate-mode: twilio_amd_bridge
Content-Type: application/json
```

#### **Body completo:**

```json
{
  "workspaceId": "workspace_id",
  "agentId": "agent_id",
  "agentPhoneNumberId": "phnum_xxx",
  "toNumber": "+34631021622",
  "fromNumber": "+34881193139",
  "variables": {
    "businessName": "Restaurante Andres",
    "customerName": "Juan Pérez"
  },
  "metadata": {
    "campaign": "sales_2024",
    "priority": "high"
  },
  "machineDetectionTimeout": 6,
  "enableMachineDetection": true,
  "concurrency": 50
}
```

#### **Opciones de personalización AMD:**

- **machineDetectionTimeout**: `1-30` segundos (por defecto: `6`)
- **enableMachineDetection**: `true/false` (por defecto: `true`)
- **concurrency**: `1-100` (por defecto: `50`)

### **POST /calls/bulk** - Llamadas en Cola

Crear múltiples llamadas con distribución automática entre agentes.

#### **Headers requeridos:**

```http
Authorization: Bearer <API_KEY>
x-gate-mode: twilio_amd_bridge
Content-Type: application/json
```

#### **Body completo:**

```json
{
  "workspaceId": "workspace_id",
  "campaignId": "campaign_123",
  "agents": [
    {
      "agentId": "agent_1",
      "agentPhoneNumberId": "phnum_xxx"
    },
    {
      "agentId": "agent_2",
      "agentPhoneNumberId": "phnum_yyy"
    }
  ],
  "machineDetectionTimeout": 8,
  "enableMachineDetection": true,
  "concurrency": 75,
  "calls": [
    {
      "toNumber": "+34631021622",
      "variables": {
        "businessName": "Restaurante Andres",
        "customerName": "Lead 1"
      }
    },
    {
      "toNumber": "+34631021623",
      "variables": {
        "businessName": "Restaurante Andres",
        "customerName": "Lead 2"
      }
    }
  ]
}
```

### **GET /calls** - Listar Llamadas

Listar llamadas con paginación y filtros.

```http
GET /calls?workspaceId=1&page=1&limit=50&status=completed
```

### **GET /calls/report** - Reporte Agregado

Reporte diario agregado de llamadas por workspace/agente.

```http
GET /calls/report?workspaceId=1&from=2024-01-01&to=2024-01-31&groupBy=agent
```

### **GET /calls/usage** - Uso de Llamadas

Métricas de duración y consumo de llamadas.

```http
GET /calls/usage?workspaceId=1&from=2024-01-01&to=2024-01-31
```

## 🔧 Configuración y Variables de Entorno

## 📊 Métricas y Reportes

### **Sistema de Métricas Inteligente**

El servicio implementa un **sistema híbrido de métricas** que combina:

- **Métricas en tiempo real**: Datos individuales de cada llamada (últimos 15 días)
- **Métricas agregadas**: Totales diarios y por campaña (retención permanente)
- **Fallback automático**: Uso inteligente de datos agregados para rangos largos

### **Retención de Datos:**

- **Call records individuales**: Se eliminan cada 15 días
- **CallDailyAggregate**: Métricas por workspace/agente (retención permanente)
- **CampaignDailyAggregate**: Métricas por campaña (retención permanente)

### **Endpoints de Métricas:**

#### **GET /calls/amd-stats** - Estadísticas AMD

```http
GET /calls/amd-stats?workspaceId=1&from=2024-08-01T00:00:00Z&to=2024-08-17T23:59:59Z&campaignId=123
```

**Respuesta:**

```json
{
  "totalCalls": 150,
  "amdStats": {
    "human": 120,
    "machine": 25,
    "unknown": 5
  },
  "amdEfficiency": {
    "humanDetectionRate": 0.8,
    "machineDetectionRate": 0.17,
    "falsePositiveRate": 0.03
  },
  "costSavings": {
    "voicemailsAvoided": 25,
    "estimatedSavings": 3.75
  }
}
```

#### **GET /calls/cost-analysis** - Análisis de Costos

```http
GET /calls/cost-analysis?workspaceId=1&from=2024-08-01T00:00:00Z&to=2024-08-17T23:59:59Z&campaignId=123
```

**Respuesta:**

```json
{
  "totalMinutes": 180.5,
  "costBreakdown": {
    "twilio": 2.25,
    "elevenLabs": 27.08,
    "total": 29.33
  },
  "costPerMinute": 0.16,
  "costPerCall": 0.2,
  "savingsFromAMD": 13.5
}
```

#### **GET /calls/quality-metrics** - Métricas de Calidad

```http
GET /calls/quality-metrics?workspaceId=1&from=2024-08-01T00:00:00Z&to=2024-08-17T23:59:59Z&campaignId=123
```

**Respuesta:**

```json
{
  "averageCallQuality": "good",
  "qualityDistribution": {
    "excellent": 45,
    "good": 60,
    "fair": 30,
    "poor": 15
  },
  "technicalMetrics": {
    "averageJitter": 2.1,
    "averagePacketLoss": 0.5,
    "averageMOS": 4.2
  }
}
```

#### **GET /calls/campaign-dashboard** - Dashboard de Campaña

```http
GET /calls/campaign-dashboard?workspaceId=1&campaignId=123&from=2024-08-01T00:00:00Z&to=2024-08-17T23:59:59Z
```

**Respuesta completa** con todas las métricas integradas.

#### **GET /calls/workspace-overview** - Vista General del Workspace

```http
GET /calls/workspace-overview?workspaceId=1&from=2024-08-01T00:00:00Z&to=2024-08-17T23:59:59Z
```

**Respuesta completa** con todas las métricas del workspace.

### **Variables requeridas:**

```bash
# ElevenLabs
ELEVENLABS_API_KEY=sk_xxx
ELEVENLABS_BASE_URL=https://api.elevenlabs.io
ELEVENLABS_OUTBOUND_CALLS_PATH=/v1/convai/sip-trunk/outbound-call

# Twilio (para AMD Bridge)
TWILIO_ACCOUNT_SID=ACxxx
TWILIO_AUTH_TOKEN=xxx
TWILIO_FROM_FALLBACK=+34881193139
PUBLIC_BASE_URL=https://voice.ateneai.com

# Redis
REDIS_URL=rediss://xxx

# Base de datos
DATABASE_URL=postgresql://xxx?sslmode=require&pgbouncer=true&connection_limit=1

# Servidor
SERVICE_PORT=3000
CALLS_WORKER_CONCURRENCY=50
RETENTION_DAYS=15
LOG_LEVEL=info
```

## 🎛️ Personalización de AMD

### **Casos de Uso Recomendados:**

#### **Llamadas de Alta Prioridad (sin AMD):**

```json
{
  "enableMachineDetection": false, // Sin AMD, conexión directa
  "machineDetectionTimeout": 3 // Si se activa, AMD rápido
}
```

#### **Campañas Masivas (AMD conservador):**

```json
{
  "machineDetectionTimeout": 8, // AMD más lento, menos falsos positivos
  "concurrency": 75 // Alta concurrencia
}
```

#### **Llamadas de Calidad (AMD estándar):**

```json
{
  "machineDetectionTimeout": 6, // Por defecto, balanceado
  "enableMachineDetection": true // AMD activado
}
```

## 📊 Capacidades y Escalabilidad

### **Rendimiento Actual:**

- **Throughput**: 2.5 llamadas/segundo
- **Capacidad diaria**: 216,000 llamadas
- **AMD timeout por defecto**: 6 segundos
- **Concurrencia por defecto**: 50 llamadas simultáneas

### **Para 100K llamadas en 7 horas:**

- **Recomendado**: Aumentar concurrencia a 80
- **Workers**: 4-5 instancias
- **Throughput objetivo**: 4+ llamadas/segundo

## 🚀 Despliegue en Railway

### **1. Conectar repositorio:**

```bash
railway login
railway init
```

### **2. Configurar variables de entorno:**

- Todas las variables listadas arriba
- **Importante**: `ELEVENLABS_OUTBOUND_CALLS_PATH` debe ser `/v1/convai/sip-trunk/outbound-call`

### **3. Desplegar:**

```bash
railway up
```

### **4. Ejecutar migraciones:**

```bash
railway run npm run prisma:migrate
```

## 🏗️ Estructura de Base de Datos

### **Modelos principales:**

- **Workspace**: Organizaciones/empresas con API keys únicas
- **Agent**: Agentes de ElevenLabs por workspace
- **WorkspacePhoneNumber**: Números de teléfono por workspace
- **AgentPhoneNumber**: Enlaces entre agentes y números
- **Campaign**: Campañas de llamadas con metadatos
- **Call**: Registro detallado de llamadas individuales con métricas avanzadas
- **CallDailyAggregate**: Reportes diarios agregados por workspace/agente (retención permanente)
- **CampaignDailyAggregate**: Reportes diarios agregados por campaña (retención permanente)

### **Relaciones:**

- **Workspace** → **Agent** (1:N)
- **Workspace** → **WorkspacePhoneNumber** (1:N)
- **Agent** → **AgentPhoneNumber** (1:N)
- **Workspace** → **Campaign** (1:N)
- **Campaign** → **Call** (1:N)

## 📈 Monitoreo y Métricas

### **Endpoints de monitoreo:**

- **Health check**: `/health`
- **Logs**: Railway dashboard
- **Métricas**: Llamadas por workspace/agente
- **Retención**: Limpieza automática cada 15 días

### **Métricas clave:**

- **Llamadas por segundo** por workspace
- **Tasa de AMD** (humanos vs máquinas)
- **Duración promedio** de llamadas
- **Costos por conversación** (excluyendo voicemails)

### **Métricas avanzadas (Call model):**

- **AMD**: `amdStatus`, `amdConfidence`, `amdDetectionTime`
- **Costos**: `costTwilio`, `costElevenLabs`, `costBreakdown`
- **Calidad**: `callQuality`, `jitter`, `packetLoss`, `mosScore`
- **Técnicas**: `twilioCallSid`, `agentModel`, `sipTrunkUsed`

### **Métricas agregadas (retención permanente):**

- **CallDailyAggregate**: `amdStats`, `costMetrics`, `qualityMetrics`, `totalMinutes`
- **CampaignDailyAggregate**: `amdStats`, `costMetrics`, `qualityMetrics`, `statusBreakdown`

## 🔒 Seguridad y Autenticación

### **API Key por workspace:**

- **Header**: `Authorization: Bearer <API_KEY>`
- **Scope**: Acceso solo a datos del workspace
- **Rotación**: API keys se pueden regenerar

### **Admin endpoints:**

- **Token**: `ORCHESTRATOR_ADMIN_TOKEN`
- **Acceso**: Gestión de workspaces y configuración global

## 🧪 Desarrollo Local

### **Instalación:**

```bash
# Clonar repositorio
git clone <repo>
cd voice-orchestrator

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

### **Variables de entorno local:**

```bash
# Crear .env.local
cp .env.example .env.local

# Configurar variables locales
DATABASE_URL=postgresql://localhost:5432/voice_orchestrator
REDIS_URL=redis://localhost:6379
```

## 📚 Casos de Uso Comunes

### **1. Llamada de ventas (AMD estándar):**

```json
{
  "x-gate-mode": "twilio_amd_bridge",
  "machineDetectionTimeout": 6,
  "enableMachineDetection": true
}
```

### **2. Llamada de soporte (sin AMD):**

```json
{
  "x-gate-mode": "twilio_amd_bridge",
  "enableMachineDetection": false
}
```

### **3. Campaña masiva (AMD conservador):**

```json
{
  "x-gate-mode": "twilio_amd_bridge",
  "machineDetectionTimeout": 8,
  "concurrency": 75
}
```

## 🆘 Troubleshooting

### **Problemas comunes:**

#### **Error 400 - "Request failed":**

- Verificar `agentPhoneNumberId` existe en ElevenLabs
- Confirmar `agentId` es válido
- Revisar configuración de SIP trunk

#### **AMD no funciona:**

- Verificar `x-gate-mode: twilio_amd_bridge`
- Confirmar credenciales de Twilio
- Revisar webhooks configurados

#### **Caller ID incorrecto:**

- Usar `agentPhoneNumberId` para SIP trunk
- Configurar ElevenLabs para SIP REFER
- Verificar configuración de Twilio SIP trunk

## 📞 Soporte

- **Documentación**: Este README
- **Issues**: GitHub Issues
- **Logs**: Railway dashboard
- **Métricas**: Endpoints de la API

---

**Voice Orchestrator** - Sistema híbrido AMD Bridge para llamadas inteligentes y escalables 🚀
