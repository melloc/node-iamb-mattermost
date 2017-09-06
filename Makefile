#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2017, Cody Mello.
#

#
# iamb-mattermost Makefile
#

#
# Tools
#
NPM		:= npm
ESLINT		= ./node_modules/.bin/eslint

#
# Files
#

JS_FILES	:= $(shell find lib test -name '*.js') \
	bin/mmreq bin/mmsh

#
# Repo-specific targets
#

$(ESLINT): | $(NPM_EXEC)
	$(NPM) install \
	    eslint@`json -f package.json devDependencies.eslint` \
	    eslint-plugin-joyent@`json -f package.json devDependencies.eslint-plugin-joyent`

.PHONY: check-eslint
check-eslint: $(ESLINT)
	$(ESLINT) $(JS_FILES)

.PHONY: check
check: | check-eslint
	@echo check ok
