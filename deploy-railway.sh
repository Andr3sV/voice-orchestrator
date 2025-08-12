#!/bin/bash

echo "🚀 Desplegando Voice Orchestrator en Railway..."

# Verificar que railway CLI esté instalado
if ! command -v railway &> /dev/null; then
    echo "❌ Railway CLI no está instalado. Instálalo con: npm install -g @railway/cli"
    exit 1
fi

# Verificar que estemos en el directorio correcto
if [ ! -f "package.json" ]; then
    echo "❌ No estás en el directorio del proyecto"
    exit 1
fi

# Hacer build del proyecto
echo "📦 Haciendo build del proyecto..."
npm run build

if [ $? -ne 0 ]; then
    echo "❌ Error en el build"
    exit 1
fi

# Verificar que el build fue exitoso
if [ ! -d "dist" ]; then
    echo "❌ El directorio dist no se creó"
    exit 1
fi

echo "✅ Build exitoso"

# Inicializar Railway si no está inicializado
if [ ! -f ".railway" ]; then
    echo "🔧 Inicializando Railway..."
    railway init
fi

# Desplegar
echo "🚀 Desplegando en Railway..."
railway up

if [ $? -eq 0 ]; then
    echo "✅ Despliegue exitoso!"
    echo "🌐 URL del servicio: $(railway status --json | jq -r '.services[0].url')"
    echo ""
    echo "📋 Próximos pasos:"
    echo "1. Configura las variables de entorno en Railway dashboard"
    echo "2. Ejecuta las migraciones: railway run npm run migrate"
    echo "3. Verifica el health check: curl $(railway status --json | jq -r '.services[0].url')/health"
else
    echo "❌ Error en el despliegue"
    exit 1
fi
