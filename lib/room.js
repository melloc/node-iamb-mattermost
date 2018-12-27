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
var mod_jsprim = require('jsprim');
var mod_mooremachine = require('mooremachine');
var mod_taiga = require('taiga');
var mod_util = require('util');

var MattermostMessage = require('./message');

// --- Internal helpers

function compareMessages(a, b) {
    var ac = a.created();
    var bc = b.created();

    if (ac < bc) {
        return (-1);
    } else if (ac === bc) {
        return (0);
    } else {
        return (1);
    }
}

// --- Exports

function MattermostRoom(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.client, 'opts.client');
    assert.object(opts.users, 'opts.users');

    this.mmr_client = opts.client;
    this.mmr_users = opts.users;

    var channel = opts.channel;
    this.mmr_id = channel.id;
    this.mmr_alias = channel.name;
    this.mmr_name = channel.display_name;
    this.mmr_type = channel.type;

    this.mmr_msgs = new mod_taiga.AVLTree({ compare: compareMessages });

    this.mmr_other = null;

    mod_mooremachine.FSM.call(this, 'waiting');
}
mod_util.inherits(MattermostRoom, mod_mooremachine.FSM);

MattermostRoom.prototype.state_waiting = function waiting(S) {
    S.validTransitions([ 'loading' ]);

    S.on(this, 'fetchAsserted', function () {
        S.gotoState('loading');
    });
};

MattermostRoom.prototype.state_loading = function loadHistory(S) {
    S.validTransitions([ 'loading', 'listening' ]);

    var self = this;

    self.mmr_client.getPostsForChannel(self.mmr_id, function (err, posts) {
        if (err) {
            S.gotoState('loading');
            return;
        }

        self._loadPosts(posts);

        S.gotoState('listening');
    });
};


MattermostRoom.prototype.state_listening = function loadHistory(S) {
    S.validTransitions([ 'loading' ]);

    var self = this;

    /*
     * When the client reconnects, we need to load any messages we
     * may have missed.
     */
    S.on(self.mmr_client, 'reconnect', function () {
        S.gotoState('loading');
    });
};


MattermostRoom.prototype._loadPost = function loadPost(post) {
    var speaker = this.mmr_users.getUser(post.user_id, null);
    var message = new MattermostMessage(this, speaker, post);

    this.append(message);
};

/*
 * Adds a new message to this room's history, and informs any listeners of it.
 *
 * We call this when initially loading messages for the room, and later on when
 * receiving new messages over the WebSocket.
 */
MattermostRoom.prototype.append = function appendPost(message) {
    message.mmm_node = this.mmr_msgs.insert(message);

    this.emit('message', message);
};


MattermostRoom.prototype._loadPosts = function loadPosts(posts) {
    assert.object(posts, 'posts');
    assert.array(posts.order, 'posts.order');
    assert.object(posts.posts, 'posts.posts');

    /*
     * Append the posts in the order the correct order so that they get
     * emitted in the appropriate order.
     */
    for (var i = posts.order.length - 1; i >= 0; --i) {
        var id = posts.order[i];
        if (mod_jsprim.hasKey(posts.posts, id)) {
            this._loadPost(posts.posts[id]);
        }
    }
};

MattermostRoom.prototype._fetch = function _startFetch() {
    this.emit('fetchAsserted');
};

MattermostRoom.prototype.id = function getId() {
    return this.mmr_id;
};

MattermostRoom.prototype.alias = function getAlias() {
    if (this.mmr_type === 'D') {
        return this.mmr_other.mmu_username;
    } else {
        return this.mmr_alias;
    }
};

MattermostRoom.prototype.name = function getName() {
    if (this.mmr_type === 'D') {
        return this.mmr_other.getDisplayName();
    } else {
        return this.mmr_name;
    }
};

MattermostRoom.prototype.sendMessage = function sendMessage(msg, cb) {
    assert.string(msg, 'msg');
    assert.func(cb, 'cb');

    this.mmr_client.createPost(this.mmr_id, msg, cb);
};

MattermostRoom.prototype.forEachMessage = function forEachMessage(f) {
    this.mmr_msgs.forEach(f);
};

module.exports = MattermostRoom;
