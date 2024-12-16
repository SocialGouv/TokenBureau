FROM node:20-alpine AS build

USER 1000
WORKDIR /app
ENV NODE_ENV=production

COPY --chown=1000:1000 yarn.lock .yarnrc.yml ./
COPY --chown=1000:1000 .yarn .yarn
RUN yarn fetch workspaces focus token-bureau-server --production && yarn cache clean

COPY packages/server ./packages/server
COPY package.json ./

EXPOSE 3000
CMD ["yarn", "workspace", "token-bureau-server", "start"]
