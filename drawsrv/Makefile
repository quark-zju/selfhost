.PHONY: build web test clean
build: web
	mkdir -p bin
	CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o bin/drawsrv .
web:
	npm --prefix web ci
	npm --prefix web run build
test:
	go test -race ./...
	npm --prefix web test
clean:
	rm -rf bin web/dist
