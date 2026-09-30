FROM node:20-alpine AS builder

WORKDIR /app

COPY packages/api/package*.json ./
RUN npm install

COPY packages/api/tsconfig.json ./
COPY packages/api/src ./src
COPY packages/api/prisma ./prisma

RUN npx prisma generate
RUN npm run build

FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

COPY packages/api/package*.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY packages/api/prisma ./prisma

EXPOSE 3001

CMD ["node", "dist/index.js"]
