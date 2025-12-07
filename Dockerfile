#####################
# Build stage
#####################
FROM node:18 AS base

WORKDIR /opt/app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm install

# Copy source code
COPY src ./src
COPY assets ./assets
COPY config ./config

# Build frontend
RUN npm run build


#####################
# Final runtime stage
#####################
FROM node:18-alpine
ENV NODE_ENV=prod

WORKDIR /opt/app

# Copy only production dependencies metadata
COPY package.json package-lock.json ./
RUN npm install --only=prod

# Copy configs (REQUIRED)
COPY config ./config

# Copy built frontend
COPY --from=base /opt/app/dist ./dist

# Copy backend scripts
COPY scripts ./scripts

# Copy static assets (optional but recommended)
COPY assets ./assets

EXPOSE 8080
ENTRYPOINT ["npm", "run", "start"]
