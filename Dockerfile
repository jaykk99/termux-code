# Hosted termux-code app (Next.js gateway + owner chatbot).
# Works on Koyeb, Render, Fly, or any Docker host:
#   docker build -t termux-code .
#   docker run -p 3000:3000 --env-file .env termux-code
# The CLI (bin/) is not used in this image; it ships from the repo via
# public/install.sh on the phone.
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=deps /app/node_modules ./node_modules
# The gateway/chatbot import lib/ and skills/ at runtime (externalDir).
COPY --from=build /app/lib ./lib
COPY --from=build /app/skills ./skills
EXPOSE 3000
CMD ["npm", "start"]
