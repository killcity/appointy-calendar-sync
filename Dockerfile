# Use smaller alpine-chrome image (~300MB vs 1.5GB)
FROM zenika/alpine-chrome:with-node

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies with npm registry workaround
USER root
RUN npm config set registry https://registry.npmmirror.com && \
    npm install --omit=dev || \
    (npm config set registry https://registry.npmjs.org && npm install --omit=dev)

# Copy app files
COPY src/ ./src/

# Create data directory
RUN mkdir -p /data && chown -R chrome:chrome /data /app

# Switch to chrome user
USER chrome

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

EXPOSE 3000

CMD ["node", "src/server.js"]
