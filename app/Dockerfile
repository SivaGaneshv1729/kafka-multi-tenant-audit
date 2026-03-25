FROM node:18-slim

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# We will use environment variables to decide whether to run Gateway or Archiver
# or run both in one process for simplicity in this small project.
CMD ["node", "index.js"]
