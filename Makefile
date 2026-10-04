.PHONY: dev build test test-web test-quant test-go compile deploy-amoy db-up db-down migrate stack

dev:
	npm run dev

build:
	npm run build

# Every suite must actually pass - a prior version of this target
# swallowed quant/Go failures with `|| true`, so a broken Python or Go
# test could sit red for a long time without `make test` ever noticing.
test: test-web test-quant test-go
	npm run test:contracts

test-web:
	npm run test:web

test-quant:
	cd quant && .venv/bin/pytest

test-go:
	cd services/chain-indexer && go test ./...

compile:
	npm run compile

deploy-amoy:
	npm run deploy:amoy

db-up:
	docker compose up -d postgres

db-down:
	docker compose down

migrate:
	npm run migrate

stack:
	bash scripts/dev_stack.sh
