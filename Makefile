ARCHES := x86 arm
# overrides to s9pk.mk must precede the include statement

# start-cli s9pk pack embeds whatever is in the LOCAL docker image cache for
# the manifest's dockerTag - it does NOT pull fresh. pull-image forces a fresh
# pull and deletes any old .s9pk so the next pack is rebuilt from it.
IMAGE := ghcr.io/syedasaadbilal-afk/xmr-accumulation-bot:latest

.PHONY: pull-image deploy

pull-image:
	@echo "Removing any locally cached image to force a fresh pull..."
	-docker rmi -f $(IMAGE) 2>/dev/null
	docker pull $(IMAGE)
	docker inspect $(IMAGE) --format '{{.Created}}'
	@echo "Removing any existing .s9pk so the next pack step is forced to rebuild..."
	-rm -f $(PACKAGE_ID)*.s9pk

deploy: pull-image arch/x86_64 install
	@echo "Deploy complete - fresh image pulled, packed, and installed."

include s9pk.mk
