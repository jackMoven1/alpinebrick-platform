FROM node:20-alpine
WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./
COPY src ./src
COPY index.html ./
COPY vite.config.js tailwind.config.js postcss.config.js ./

# Install dependencies
RUN npm install

# Build React app with Vite
RUN npm run build

# Expose port
EXPOSE 3000

# Start server
CMD ["node", "src/server.js"]
