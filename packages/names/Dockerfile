# The name service is two files and no dependencies, so the image is the
# runtime and those files. Built from this folder:
#
#   docker build packages/names
FROM node:22-alpine

RUN apk add --no-cache su-exec

WORKDIR /app
COPY names.mjs server.mjs start.sh ./

ENV PORT=8080
EXPOSE 8080

CMD ["./start.sh"]
