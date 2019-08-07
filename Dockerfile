FROM node:10.16

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 9090
#EXPOSE 3002

CMD [ "npm", "run", "star-signal" ]