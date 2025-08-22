# Deployment en Coolify

## Configuración Necesaria

### Variables de Entorno

Asegúrate de configurar estas variables de entorno en Coolify:

```
ANDREANI_EMAIL=tu-email@example.com
ANDREANI_PASSWORD=tu-password
NODE_ENV=production
DOCKER_ENV=true
```

### Puerto

- Puerto interno: `3000`
- El contenedor expone el puerto 3000

### Health Check

La aplicación incluye un endpoint de health check en `/health` que Coolify puede usar para verificar el estado del contenedor.

## Dockerfile

El proyecto incluye un Dockerfile optimizado para Puppeteer que:

1. Usa Node.js 18 Alpine para un tamaño menor
2. Instala Chromium y todas las dependencias necesarias
3. Configura las variables de entorno correctas para Puppeteer
4. Usa un usuario no-root para mayor seguridad
5. Incluye un health check configurado

## Optimizaciones para Contenedores

### Puppeteer Configuration

El código detecta automáticamente si está ejecutándose en un contenedor y:

- Usa `puppeteer-core` en lugar de `puppeteer` completo
- Aplica argumentos optimizados para Docker
- Usa timeouts extendidos para compensar recursos limitados
- Desactiva imágenes y JavaScript innecesario para mejor rendimiento

### Browser Arguments

En contenedores se aplican estos argumentos adicionales:

- `--single-process`: Usa un solo proceso
- `--disable-dev-shm-usage`: Evita problemas de memoria compartida
- `--disable-gpu`: Desactiva aceleración por hardware
- `--disable-images`: No carga imágenes (mejor rendimiento)

### Debugging

Si hay problemas, el código:

- Toma screenshots automáticamente en caso de error
- Busca elementos alternativos si no encuentra el selector principal
- Proporciona logs detallados del estado del DOM

## Troubleshooting

### Si continúa fallando:

1. **Verifica los logs**: Revisa los logs de Coolify para ver errores específicos
2. **Memory**: Asegúrate de que el contenedor tenga al menos 512MB de RAM
3. **Timeout**: Los timeouts se han extendido, pero si continúa fallando, puede necesitar ajustar los recursos del contenedor

### Logs importantes a verificar:

- `📍 URL actual después del login`: Debe mostrar la URL correcta
- `🎯 Buscando botón 'Hacer envío'`: Debe encontrar el elemento
- `🔍 Botones relacionados con 'envío' encontrados`: Si falla, mostrará alternativas

## Build Process

Coolify debería:

1. Detectar automáticamente el Dockerfile
2. Instalar las dependencias correctas
3. Configurar el entorno para producción
4. Usar el health check incluido

No necesitas configuración adicional si usas el Dockerfile incluido.
