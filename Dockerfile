# Use Node.js 20 as base image
FROM node:20-slim AS builder

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Build the project
RUN npm run build

# Use a smaller runtime image
FROM node:20-slim

# Set working directory
WORKDIR /app

# Copy built files and package files
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules

# Create a directory for persistent data
RUN mkdir -p /root/.gemini-cli-telegram

# Set environment variables
ENV NODE_ENV=production

# The bot doesn't expose any ports by default, but we can document it
# EXPOSE 8080

# Start the bot
CMD ["node", "dist/cli.js", "start"]
