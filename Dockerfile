# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including devDependencies if needed for build/tests)
RUN npm ci

# Copy source code
COPY . .

# Remove development dependencies to keep the production image small
RUN npm prune --omit=dev

# Stage 2: Production
FROM node:20-alpine

WORKDIR /app

# Set environment to production
ENV NODE_ENV=production

# Copy only necessary files from builder
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/index.js ./index.js

# Expose Express port
EXPOSE 9898

# Start the server
CMD ["node", "index.js"]
