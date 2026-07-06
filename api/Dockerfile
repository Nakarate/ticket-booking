FROM golang:1.22-alpine
WORKDIR /app
COPY go.mod ./
COPY . .
RUN go mod tidy && go build -o /server .
EXPOSE 8080
CMD ["/server"]
