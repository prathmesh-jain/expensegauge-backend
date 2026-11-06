# syntax=docker/dockerfile:1

# Debian slim (glibc) so bcrypt uses its prebuilt binary instead of compiling
FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production

# Copy only the manifests first: this layer (and the npm install) is cached
# and reused on every deploy until package*.json changes
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund

COPY . .

USER node
EXPOSE 3000

HEALTHCHECK --interval=40s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/v1/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Run node directly in production; nodemon (npm start) is for local development
CMD ["node", "app.js"]
