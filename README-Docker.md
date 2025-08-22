# Andreani Token Service - Docker

Este proyecto incluye configuración completa de Docker para ejecutar el servicio de tokens de Andreani.

## 🚀 Configuración Rápida

### 1. Variables de Entorno

Crea un archivo `.env` en la raíz del proyecto:

```bash
# Configuración de Andreani
ANDREANI_EMAIL=tu-email@andreani.com
ANDREANI_PASSWORD=tu-contraseña
```

### 2. Crear directorio para screenshots

```bash
mkdir screenshots
```

### 3. Construir y ejecutar con Docker Compose

```bash
# Construir y ejecutar en modo detached
docker-compose up -d --build

# Ver logs en tiempo real
docker-compose logs -f andreani-service

# Parar el servicio
docker-compose down
```

## 🔧 Comandos Útiles

### Docker Compose

```bash
# Construir solo la imagen
docker-compose build

# Ejecutar en primer plano (ver logs directamente)
docker-compose up

# Reiniciar el servicio
docker-compose restart andreani-service

# Ver estado del servicio
docker-compose ps

# Ejecutar bash dentro del contenedor
docker-compose exec andreani-service sh
```

### Docker directo

```bash
# Construir imagen
docker build -t andreani-token-service .

# Ejecutar contenedor
docker run -d \
  --name andreani-service \
  -p 3000:3000 \
  -e ANDREANI_EMAIL=tu-email@andreani.com \
  -e ANDREANI_PASSWORD=tu-contraseña \
  -v $(pwd)/screenshots:/app/screenshots \
  andreani-token-service
```

## 📝 Endpoints Disponibles

Una vez que el contenedor esté ejecutándose, los endpoints estarán disponibles en `http://localhost:3000`:

- `POST /get-andreani-token` - Obtener token de Andreani
- `POST /hacer-envio` - Realizar proceso completo de envío
- `POST /get-sucursal-id` - Obtener ID de sucursal por CP

## 🔍 Monitoreo

### Health Check

El contenedor incluye un health check que verifica cada 30 segundos si el servicio está funcionando:

```bash
# Ver estado de salud
docker-compose ps
```

### Logs

```bash
# Ver logs del servicio
docker-compose logs andreani-service

# Seguir logs en tiempo real
docker-compose logs -f andreani-service
```

## 🐛 Troubleshooting

### Screenshots de errores

Los screenshots de errores se guardan en `./screenshots/` y están montados como volumen.

### Problemas comunes

1. **Puerto 3000 ocupado**: Cambia el puerto en `docker-compose.yml`:
   ```yaml
   ports:
     - "3001:3000"  # Usar puerto 3001 en el host
   ```

2. **Problemas de memoria**: Puppeteer consume memoria. Ajusta los límites en `docker-compose.yml`:
   ```yaml
   deploy:
     resources:
       limits:
         memory: 2G
   ```

3. **Chromium no funciona**: El Dockerfile incluye todas las dependencias necesarias para Alpine Linux.

## 📦 Versiones

Este Docker setup usa exactamente las mismas versiones de tu entorno local:

- **Node.js**: v22.15.0
- **npm**: v10.9.2
- **Dependencias**: Las especificadas en `package.json`

## 🔧 Desarrollo

Para desarrollo con hot reload, descomenta esta línea en `docker-compose.yml`:

```yaml
volumes:
  - ./andreani.js:/app/andreani.js:ro
```

Luego reinicia el contenedor cuando hagas cambios en el código. 