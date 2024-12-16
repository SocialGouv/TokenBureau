FROM node:22-alpine AS build

USER 1000
WORKDIR /app
ENV NODE_ENV=production

COPY --chown=1000:1000 yarn.lock .yarnrc.yml ./
COPY --chown=1000:1000 .yarn .yarn
RUN yarn fetch workspaces focus --production && yarn cache clean

COPY server ./server
COPY package.json ./

EXPOSE 3000
CMD ["yarn", "start"]
