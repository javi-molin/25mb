# 25mb — Divisor de ZIP

Página web que recibe ZIP grandes y los devuelve repartidos en varios ZIP de como máximo 25 MB
(configurable), con el mismo nombre numerado: `nombre_1.zip`, `nombre_2.zip`, …

Todo funciona en el navegador: los archivos no se suben a ningún servidor.

## Uso

Abre `index.html` (o la página publicada con GitHub Pages), arrastra uno o varios ZIP y descarga las
partes. En Chrome/Edge puedes elegir una carpeta para que las partes se guarden directamente ahí.

## Cómo reparte los archivos

- Mantiene la estructura de carpetas original dentro de cada parte.
- Una carpeta que cabe entera en una parte (p. ej. un chat con sus fotos y audios) no se separa nunca.
- Una carpeta mayor que el límite se corta en tramos consecutivos por orden de nombre.
- Los bloques se combinan (first-fit decreasing) para generar el menor número de partes posible.
- Los archivos se copian sin recomprimir, así que el tamaño de cada parte se conoce de antemano y no se
  pierde calidad. Cada parte se comprueba al terminar y, si superase el límite, se vuelve a dividir.
- Un archivo que por sí solo supera el límite se trocea en `archivo.001`, `archivo.002`, … y se incluye un
  `COMO_UNIR_archivo.txt` con los comandos para unirlo de nuevo en Windows y Mac/Linux.
- Al final se verifica que todos los archivos del ZIP original aparecen en alguna parte.

## Publicarla con GitHub Pages

Settings → Pages → *Deploy from a branch* → elige la rama y la carpeta `/ (root)`.

Usa [zip.js](https://github.com/gildas-lormeau/zip.js) (BSD-3-Clause), incluido en `lib/`.
