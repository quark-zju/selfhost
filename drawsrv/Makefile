SHELL := /bin/sh
.DEFAULT_GOAL := build

BINARY := drawsrv
BUILD_OUTPUT := bin/$(BINARY)
WEB_BUILD := web/dist
GO ?= go
NPM ?= npm
TARGET_OS ?= linux
TARGET_ARCH ?= amd64
RELEASE_DIR ?= dist
PREFIX ?= /usr/local/bin
INSTALL_PATH := $(PREFIX)/$(BINARY)
SHARE_DIR ?= /usr/local/share/drawsrv
WEB_DIR ?= $(SHARE_DIR)/web
CONFIG_DIR ?= /etc/drawsrv
ENV_FILE ?= $(CONFIG_DIR)/drawsrv.env
SYSTEMD_DIR ?= /etc/systemd/system
SERVICE_USER ?= drawsrv
SERVICE_GROUP ?= $(SERVICE_USER)
SUDO ?= sudo
SYSTEMCTL ?= systemctl
DESTDIR ?=

.PHONY: build build-go web release test test-deploy fmt clean help check-git check-artifacts install setup-user install-config install-systemd deploy enable restart status

build: web build-go

build-go:
	mkdir -p bin
	CGO_ENABLED=0 $(GO) build -trimpath -ldflags='-s -w' -o $(BUILD_OUTPUT) .

web:
	$(NPM) --prefix web ci
	$(NPM) --prefix web run build

# This bundle includes prebuilt artifacts and deployment recipes, so installing
# it on the VPS needs neither Go nor Node.js. Compile on a larger machine/CI.
release: web
	@set -eu; \
	stage=$$(mktemp -d); \
	trap 'rm -rf "$$stage"' 0 HUP INT TERM; \
	mkdir -p "$$stage/drawsrv/bin" "$$stage/drawsrv/web" "$(RELEASE_DIR)"; \
	CGO_ENABLED=0 GOOS=$(TARGET_OS) GOARCH=$(TARGET_ARCH) $(GO) build -trimpath -ldflags='-s -w' -o "$$stage/drawsrv/bin/drawsrv" .; \
	cp -R $(WEB_BUILD) "$$stage/drawsrv/web/dist"; \
	cp -R deploy "$$stage/drawsrv/deploy"; \
	cp Makefile README.md "$$stage/drawsrv/"; \
	tar -czf "$(RELEASE_DIR)/drawsrv-$(TARGET_OS)-$(TARGET_ARCH).tar.gz" -C "$$stage" drawsrv

test:
	$(GO) test -race ./...
	$(NPM) --prefix web test

test-deploy:
	sh deploy/test-install.sh

fmt:
	$(GO) fmt ./...

check-git:
	@if ! command -v git >/dev/null 2>&1; then \
		echo 'Git 2.36+ is required on the runtime host; install Git first' >&2; exit 1; \
	fi

check-artifacts:
	@test -x $(BUILD_OUTPUT) && test -f $(WEB_BUILD)/index.html || \
		{ echo 'Missing build artifacts: run make build locally or unpack a release bundle' >&2; exit 1; }

# Deliberately does not depend on build: a small VPS installs existing artifacts.
install: check-git check-artifacts
	$(SUDO) install -d -m 755 "$(DESTDIR)$(PREFIX)" "$(DESTDIR)$(SHARE_DIR)" "$(DESTDIR)$(WEB_DIR)"
	@set -eu; \
	for asset in $(WEB_BUILD)/*; do \
		[ "$${asset##*/}" = index.html ] && continue; \
		$(SUDO) cp -R "$$asset" "$(DESTDIR)$(WEB_DIR)/"; \
	done
	$(SUDO) chmod -R u=rwX,go=rX "$(DESTDIR)$(WEB_DIR)"
	$(SUDO) install -m 644 $(WEB_BUILD)/index.html "$(DESTDIR)$(WEB_DIR)/index.html.new"
	$(SUDO) mv -f "$(DESTDIR)$(WEB_DIR)/index.html.new" "$(DESTDIR)$(WEB_DIR)/index.html"
	$(SUDO) install -m 755 $(BUILD_OUTPUT) "$(DESTDIR)$(INSTALL_PATH).new"
	$(SUDO) mv -f "$(DESTDIR)$(INSTALL_PATH).new" "$(DESTDIR)$(INSTALL_PATH)"

setup-user:
	@if ! command -v getent >/dev/null 2>&1; then \
		echo 'Service account setup requires Linux account tools (getent, groupadd, useradd)' >&2; exit 1; \
	fi
	@if ! getent group $(SERVICE_GROUP) >/dev/null; then \
		$(SUDO) groupadd --system $(SERVICE_GROUP); \
	fi
	@if ! getent passwd $(SERVICE_USER) >/dev/null; then \
		$(SUDO) useradd --system --gid $(SERVICE_GROUP) --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin $(SERVICE_USER); \
	fi

install-config:
	$(SUDO) install -d -m 755 "$(DESTDIR)$(CONFIG_DIR)"
	@if [ ! -e "$(DESTDIR)$(ENV_FILE)" ]; then \
		$(SUDO) install -m 644 deploy/drawsrv.env.example "$(DESTDIR)$(ENV_FILE)"; \
	fi

install-systemd:
	@set -eu; \
	unit=$$(mktemp); \
	trap 'rm -f "$$unit"' 0 HUP INT TERM; \
	sed -e 's|^User=drawsrv$$|User=$(SERVICE_USER)|' \
		-e 's|^Group=drawsrv$$|Group=$(SERVICE_GROUP)|' \
		-e 's|/usr/local/bin/drawsrv|$(INSTALL_PATH)|g' \
		-e 's|/usr/local/share/drawsrv/web|$(WEB_DIR)|g' \
		-e 's|/etc/drawsrv/drawsrv.env|$(ENV_FILE)|g' \
		deploy/drawsrv.service > "$$unit"; \
	$(SUDO) install -d -m 755 "$(DESTDIR)$(SYSTEMD_DIR)"; \
	$(SUDO) install -m 644 "$$unit" "$(DESTDIR)$(SYSTEMD_DIR)/drawsrv.service"; \
	if [ -z "$(DESTDIR)" ]; then \
		$(SUDO) $(SYSTEMCTL) daemon-reload; \
		$(SUDO) $(SYSTEMCTL) enable drawsrv.service; \
	fi

# Deployment enables boot startup without starting or restarting the service.
deploy: setup-user install install-config install-systemd

enable:
	$(SUDO) $(SYSTEMCTL) enable --now drawsrv.service

restart:
	$(SUDO) $(SYSTEMCTL) restart drawsrv.service

status:
	$(SUDO) $(SYSTEMCTL) status drawsrv.service

clean:
	rm -rf bin web/dist $(RELEASE_DIR)

help:
	@echo 'make build           Build frontend and native Go binary locally'
	@echo 'make release         Build Linux amd64 deployment archive (TARGET_ARCH=arm64 supported)'
	@echo 'make deploy          Install prebuilt artifacts, account, config and systemd unit'
	@echo 'make enable          Enable and start the installed service'
	@echo 'make restart         Restart after an upgrade/config change'
	@echo 'make test-deploy     Verify staged installation without root or systemd'
