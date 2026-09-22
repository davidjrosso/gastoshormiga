# Imagen única que sirve la API y el front compilado en un solo proceso Node.
# Pensada para convivir con otras apps en el mismo VPS: no necesita base de
# datos externa, así que no hay un Postgres comiendo RAM al lado.

FROM node:22-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 es un módulo nativo. Suele haber binario precompilado, pero
# si no lo hay necesita toolchain para compilarse, y sin esto el build falla
# con un error poco obvio.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY web/package*.json web/
RUN cd web && npm ci

COPY web/ web/
COPY server/src/statements/model.ts server/src/statements/model.ts
COPY server/src/import/types.ts server/src/import/types.ts
RUN cd web && node scripts/make-icons.mjs && npm run build

COPY server/package*.json server/
RUN cd server && npm ci

COPY server/ server/
RUN cd server && npm run build

# Sacamos las dependencias de desarrollo y nos quedamos con el node_modules
# ya compilado, que la etapa final copia tal cual (misma imagen base, misma
# arquitectura: el binario nativo sirve).
RUN cd server && npm prune --omit=dev


FROM node:22-bookworm-slim AS runtime
WORKDIR /app

COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/dist         ./server/dist
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/web/dist            ./web/dist

WORKDIR /app/server

ENV NODE_ENV=production \
    PORT=3001 \
    DATABASE_PATH=/data/hormiga.db

# La base va afuera del contenedor. Si no montás este volumen, perdés
# todos los gastos en el primer redeploy.
VOLUME ["/data"]

EXPOSE 3001

# No corre como root.
USER node

CMD ["node", "dist/index.js"]
