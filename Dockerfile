FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY server.js ./
COPY h5/ ./h5/
EXPOSE 3000
CMD ["node", "server.js"]
