# Margen: de esta carpeta a un APK

Margen es una app web instalable. Para convertirla en APK hay que publicarla en internet (gratis, con GitHub Pages) y pasarla por PWABuilder. Todo se puede hacer desde el celular, aunque desde un computador es más cómodo.

## 1. Consigue tu clave de Gemini (2 minutos)

1. Entra a https://aistudio.google.com/apikey con tu cuenta de Google.
2. Toca «Create API key» y copia la clave (empieza por `AIza…`).
3. Guárdala. La pegarás dentro de la app, en Ajustes → Conexión con Gemini.

**Importante sobre privacidad:** en el nivel gratuito, Google puede usar lo que envías para mejorar sus productos, y fuera de Europa pueden revisarlo personas. Si tus novelas son manuscritos inéditos que no quieres compartir con Google, activa la facturación en AI Studio (nivel de pago, que excluye ese uso) o no subas esas novelas.

## 2. Publica la app en GitHub Pages

1. Crea una cuenta gratuita en https://github.com (si usas el celular, activa «Ver versión para computador» en el navegador).
2. Toca «+» → «New repository».
3. En el nombre escribe exactamente `TUUSUARIO.github.io` (cambia TUUSUARIO por tu nombre de usuario de GitHub). Déjalo en «Public» y créalo.
4. Toca «uploading an existing file», selecciona **todos los archivos de esta carpeta** y luego «Commit changes».
5. Ve a Settings → Pages. En «Branch» elige `main` y guarda.
6. Espera uno o dos minutos y abre `https://TUUSUARIO.github.io`. Deberías ver Margen.

## 3. Genera el APK con PWABuilder

1. Entra a https://www.pwabuilder.com, pega tu dirección `https://TUUSUARIO.github.io` y toca «Start».
2. Elige «Package for stores» → «Android» → «Generate Package».
3. Descarga el ZIP. Dentro está el archivo `.apk`.
4. Pásalo a tu celular, ábrelo y permite «instalar apps de origen desconocido» cuando Android lo pida.

Guarda también el archivo `signing.keystore` y las contraseñas que vienen en ese ZIP: las necesitas si algún día quieres actualizar la app con la misma firma.

## 4. (Opcional) Quitar la barra de dirección

Si al abrir la app ves arriba una barra con la dirección web, falta un archivo de verificación:

1. En el ZIP de PWABuilder hay un archivo `assetlinks.json`. Ábrelo y copia su contenido.
2. En tu repositorio de GitHub toca «Add file» → «Create new file».
3. En el nombre escribe `.well-known/assetlinks.json`, pega el contenido y guarda.
4. Crea otro archivo nuevo llamado `.nojekyll`, vacío, y guárdalo (sin él, GitHub oculta la carpeta `.well-known`).
5. Espera unos minutos y vuelve a abrir la app.

## Cómo funciona

- **Estante:** toca «Añadir» para subir PDF (o .txt). El texto se extrae y se guarda en el teléfono. Los PDF escaneados como imagen no se pueden leer.
- **Fichas:** al añadir una novela, la IA crea una ficha con resumen, personajes y momentos clave, que siempre tiene presente al charlar.
- **Charla:** en cada mensaje la app busca los fragmentos de tus novelas relacionados con lo que escribes y se los pasa a la IA. Toca «Consultó N pasajes» para ver cuáles y abrirlos en el lector.
- **«Leyendo:»** arriba en la charla eliges qué novelas consulta.
- **Ajustes → Personalidad:** nombre, ícono, carácter, gustos, manías, forma de hablar y lo que sabe de ti. Hay tres plantillas para empezar.
- **Respaldo:** todo vive en el teléfono; si desinstalas la app, se borra. Usa «Exportar respaldo» de vez en cuando.

## Si algo falla

- «Llegaste al límite del nivel gratuito»: espera un minuto. Si usas «Novela completa», cambia a «Fragmentos relevantes».
- «Ese modelo no está disponible»: en Ajustes toca «Probar conexión» y elige otro modelo de la lista.
- «Gemini bloqueó esta respuesta»: sus filtros a veces cortan escenas explícitas o violentas. Reformula la pregunta.
- Para actualizar la app: sube los archivos nuevos al mismo repositorio. El APK instalado se actualiza solo la próxima vez que lo abras con internet.

pdf.js © Mozilla, licencia Apache 2.0 (ver LICENSE-pdfjs.txt).
