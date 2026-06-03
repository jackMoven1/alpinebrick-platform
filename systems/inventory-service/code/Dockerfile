FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
RUN npm install --production
EXPOSE 4003
CMD ["node", "src/index.js"]
