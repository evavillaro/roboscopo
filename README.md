# Roboscopo

Horóscopos contrastados con las portadas de los periódicos, escritos cada mañana a las 06:00 por la Unidad R-42, un robot con un cerebro del tamaño de un planeta que no se cree ni a los astros ni a las portadas.

## Cómo funciona

```
06:00 Madrid ──► GitHub Actions ──► scripts/edicion.mjs
                                      │  lee portadas por RSS (El Mundo, El País, eldiario.es, ABC, La Vanguardia, RTVE, 20minutos, El Periódico)
                                      │  lee los horóscopos del día (20minutos, El Periódico, La Vanguardia, ABC)
                                      │  consulta el tiempo de 6 capitales (Open-Meteo)
                                      │  UNA llamada a Claude ──► JSON con editorial, 12 signos, 4 grupos de edad
                                      └─► data/hoy.json  (+ copia en data/ediciones/AAAA-MM-DD.json)  ──► commit ──► GitHub Pages
```

La web (`index.html`) es estática: carga `data/hoy.json` y, cuando alguien pide el suyo, busca su ciudad en Open-Meteo y consulta el tiempo en directo. Nada se guarda en ningún servidor; ciudad, mes y año se quedan en el navegador.

- **Signo**: sale del mes de nacimiento (con aviso si el mes tiene dos signos).
- **Grupo de edad**: joven (menos de 30), maduro (30-49), remaduro (50-64), veterano (65 o más). Es independiente del signo: depende de la edad y del tiempo que haga.
- **Coincidencia**: el robot puntúa de 0 a 100 cuánto coincide lo que prometen los astros con lo que traen las portadas, y resalta los titulares que afectan a cada signo y grupo.

## Puesta en marcha

1. **Clave de Anthropic** (secreto del repositorio):
   ```
   gh secret set ANTHROPIC_API_KEY
   ```
   Pega la clave cuando la pida. Sin esto el flujo diario falla.
2. **GitHub Pages**: Settings → Pages → Source: *Deploy from a branch*, rama `main`, carpeta `/ (root)`.
3. **Dominio**: en Settings → Pages → Custom domain escribe el dominio (por ejemplo `roboscopo.es`). GitHub crea el archivo `CNAME`. En el registrador del dominio:
   - Registros `A` de `@` apuntando a `185.199.108.153`, `185.199.109.153`, `185.199.110.153` y `185.199.111.153`.
   - Registro `CNAME` de `www` apuntando a `evavillaro.github.io`.
   - Marca *Enforce HTTPS* cuando GitHub valide el dominio (tarda de minutos a una hora).
4. **Primera edición real**: Actions → *Edición de las 06:00* → *Run workflow* con `force` marcado. A partir de ahí se genera sola cada mañana.

## Ejecutar en local

```
npm install
set ANTHROPIC_API_KEY=sk-ant-...     (PowerShell: $env:ANTHROPIC_API_KEY="sk-ant-...")
npm run edicion:forzar               (regenera data/hoy.json aunque ya exista la de hoy)
npm run servir                       (abre http://localhost:8080)
```

## Ajustes

- **Modelo**: por defecto `claude-haiku-4-5`, el más barato. Para cambiarlo sin tocar código, crea la variable de repositorio `ROBOSCOPO_MODEL` (Settings → Secrets and variables → Actions → Variables), por ejemplo `claude-opus-5` si quieres un robot más ingenioso a cambio de unos 3 € al mes.
- **Voz del robot**: la constante `PERSONA` en `scripts/edicion.mjs`.
- **Fuentes**: las listas `PORTADAS` y `HOROSCOPOS` en el mismo archivo. Si una fuente falla, se ignora; si fallan todas las de horóscopos, el robot los reconstruye y lo dice en la web.
- **Hora**: el cron corre a las 04:00 y 05:00 UTC; el script solo redacta si en Madrid son las 06:00 o más y aún no hay edición del día.

## Coste

Una llamada al día. Con `claude-haiku-4-5` (por defecto), alrededor de un céntimo por edición: unos 30 céntimos al mes. Con `claude-opus-5`, unos 3 € al mes. GitHub Pages y Actions, Open-Meteo y los RSS son gratuitos.
