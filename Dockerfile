FROM node:22-alpine
WORKDIR /opt/job-pipeline
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev
CMD ["node", "dist/cli.js", "pipeline"]
