#####################
# Build stage
#####################
FROM node:18 AS builder

WORKDIR /opt/app

# Install dependencies for building
COPY package.json package-lock.json ./
RUN npm install

# Copy full source code
COPY src ./src
COPY assets ./assets
COPY config ./config
COPY scripts ./scripts

# Build frontend
RUN npm run build


#####################
# Final runtime stage
#####################
FROM node:18-alpine

ENV NODE_ENV=production
WORKDIR /opt/app

# Copy package metadata
COPY package.json package-lock.json ./

# Install only production dependencies (includes mongoose + ioredis)
RUN npm install --omit=dev

# Copy configs
COPY config ./config

# Copy backend scripts
COPY scripts ./scripts

# Copy static assets
COPY assets ./assets

# Copy built frontend from builder
COPY --from=builder /opt/app/dist ./dist

# OPTIONAL (recommended for uploads folder)
RUN mkdir -p public/uploads

EXPOSE 8080

CMD ["npm", "run", "start"]