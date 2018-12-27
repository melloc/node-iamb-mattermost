/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018, Cody Mello.
 */

'use strict';

var assert = require('assert-plus');
var mod_events = require('events');
var mod_util = require('util');

// --- Exports

function MattermostMessage(room, speaker, post) {
    assert.object(room, 'room');
    assert.object(speaker, 'speaker');
    assert.object(post, 'post');

    this.mmm_id = null;
    this.mmm_room = room;
    this.mmm_speaker = speaker;
    this.mmm_post = post;
    this.mmm_node = null;

    mod_events.EventEmitter.call(this);
}
mod_util.inherits(MattermostMessage, mod_events.EventEmitter);

MattermostMessage.prototype.speaker = function getSpeaker() {
    return this.mmm_speaker;
};

MattermostMessage.prototype.text = function getText() {
    return this.mmm_post.message;
};

MattermostMessage.prototype.created = function getCreated() {
    return this.mmm_post.create_at;
};

module.exports = MattermostMessage;
