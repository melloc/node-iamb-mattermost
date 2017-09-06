/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017, Cody Mello.
 */

'use strict';

var assert = require('assert-plus');
var mod_mooremachine = require('mooremachine');
var mod_path = require('path');
var mod_restify = require('restify-clients');
var mod_util = require('util');
var mod_watershed = require('watershed');
var VError = require('verror');

var shed = new mod_watershed.Watershed();

function MattermostClient(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.url, 'opts.url');
    assert.object(opts.account, 'opts.account');
    assert.string(opts.account.username, 'opts.account.username');
    assert.optionalString(opts.account.password, 'opts.account.password');
    assert.optionalString(opts.account.token, 'opts.account.token');
    assert.ok(opts.account.token || opts.account.password,
        'one of opts.account.token or opts.account.password must be provided');
    assert.optionalObject(opts.agent, 'opts.agent');

    this.log = opts.log;
    this.url = opts.url;

    this.client = mod_restify.createJsonClient({
        agent: opts.agent,
        url: this.url
    });

    this.httpClient = mod_restify.createHttpClient({
        agent: opts.agent,
        url: this.url
    });

    this.account = opts.account;
    this.username = opts.account.username;
    this.token = null;
    this.user = null;

    this.lastErr = null;
    this._mmws = null;

    mod_mooremachine.FSM.call(this, 'authenticating');
}
mod_util.inherits(MattermostClient, mod_mooremachine.FSM);


MattermostClient.prototype.state_authenticating = function (S) {
    S.validTransitions([ 'connecting', 'failed' ]);

    var self = this;

    if (self.account.token) {
        S.immediate(function () {
            self.token = self.account.token;
            self.getUserByName(self.username, function (err, obj) {
                if (err) {
                    self.lastErr = err;
                    S.gotoState('failed');
                    return;
                }

                self.user = obj;

                S.gotoState('connecting');
            });
        });
    } else {
        S.immediate(function () {
            self.client.post('/api/v4/users/login', {
                login_id: self.account.username,
                password: self.account.password
            }, function (err, req, res, obj) {
                if (err) {
                    S.lastErr = err;
                    S.gotoState('failed');
                    return;
                }

                self.token = res.headers.token;
                self.user = obj;

                S.gotoState('connecting');
            });
        });
    }
};


MattermostClient.prototype.state_connecting = function (S) {
    S.validTransitions([ 'connected', 'failed' ]);

    var self = this;

    var wskey = shed.generateKey();

    self.httpClient.get({
        path: '/api/v4/websocket',
        headers: {
            connection: 'upgrade',
            upgrade: 'websocket',
            'sec-websocket-key': wskey,
            'sec-websocket-version': 13,
            'Authorization': 'Bearer ' + self.token
        }
    }, function (gErr, req) {
        if (gErr) {
            self.lastErr = gErr;
            S.gotoState('failed');
            return;
        }

        req.once('upgradeResult', function (uErr, res, socket, head) {
            if (uErr) {
                self.lastErr = uErr;
                S.gotoState('failed');
                return;
            }

            socket.setNoDelay(true);
            self._mmws = shed.connect(res, socket, head, wskey);

            S.gotoState('connected');
        });
    });
};


MattermostClient.prototype.state_connected = function (S) {
    S.validTransitions([ 'connecting', 'failed' ]);

    var self = this;

    S.on(self._mmws, 'text', function (msg) {
        var obj;

        try {
            obj = JSON.parse(msg);
        } catch (e) {
            self.log.warn({
                err: e,
                payload: msg
            }, 'failed to parse JSON message');
            return;
        }

        self._processEvent(obj);
    });

    S.on(self._mmws, 'connectionReset', function () {
        S.gotoState('connecting');
    });

    S.on(self._mmws, 'error', function (err) {
        self.lastErr = err;
        S.gotoState('failed');
    });

    S.on(self._mmws, 'end', function () {
        self.log.info('websocket ended; restarting connection');
        S.gotoState('connecting');
    });

    /*
     * Inform consumers that we're now connected.
     */
    S.immediate(function () {
        self.emit('connected', self.user);
    });
};


MattermostClient.prototype.state_failed = function (S) {
    S.validTransitions([ ]);

    assert.ok(this.lastErr, 'lastErr is set');
    this.emit('error', this.lastErr);
};


MattermostClient.prototype._processPosted = function (obj) {
    var self = this;
    var post;

    try {
        post = JSON.parse(obj.data.post);
    } catch (e) {
        self.log.warn({
            err: e,
            payload: obj
        }, 'received weird "posted" message');
        return;
    }

    switch (post.type) {
    case '':
        /*
         * A normal message has an empty string for "type":
         */
        self.emit('message', obj.data, post);
        return;
    case 'slack_attachment':
        /*
         * Sent when webhooks are called (e.g., integrations with CI
         * systems like Jenkins). "props" contains:
         *   - "attachments", an array of attachments
         */
        return;
    case 'system_header_change':
        /*
         * Sent when a room header changes.
         */
        return;
    case 'system_add_to_channel':
        /*
         * When someone adds a user to a channel. "props" contains:
         *   - "addedUsername", the user added to the channel
         *   - "username", the user who did the adding
         *
         * Both of these are actual names, like "joybot2" or
         * "cody.mello", and not IDs.
        */
        return;
    case 'system_join_channel':
        /*
         * Sent when a user joins a channel. "props" contains:
         *   - "username", the user who joined
         */
        return;
    case 'system_leave_channel':
        /*
         * Sent when a user leaves a channel. "props" contains:
         *   - "username", the user who left
         */
        return;
    case 'system_remove_from_channel':
        /*
         *
         */
        return;
    case 'system_displayname_change':
        /*
         *
         */
        return;
    case 'system_purpose_change':
        /*
         *
         */
        return;
    case 'system_channel_deleted':
        /*
         *
         */
        return;
    case 'system_ephemeral':
        /*
         *
         */
        return;
    case 'system_generic':
        /*
         * Seems to be unused?
         */
        return;
    default:
        self.log.warn({
            type: post.type,
            message: obj
        }, 'received unknown message type');
        return;
    }
};

MattermostClient.prototype._processEvent = function (obj) {
    var self = this;

    self.log.debug({ payload: obj }, 'event received');

    switch (obj.event) {
    case 'hello':
        /*
         * Sent after initially connecting to the websocket.
         */
        break;

    case 'typing':
        /*
         * Sent to indicate that a user is currently typing.
         */
        break;

    case 'channel_viewed':
        /*
         * Sent after the user has viewed a channel.
         */
        break;

    case 'channel_updated':
        /*
         * Sent when channel properties are updated.
         */
        break;

    case 'posted':
        /*
         * Sent when a message has been posted into a channel.
         */
        this._processPosted(obj);
        break;

    case 'post_edited':
        /*
         * Sent when a post gets edited by a user.
         */
        break;

    case 'status_change':
        /*
         * Sent when a user's status changes.
         * "data" contains:
         *   - "status", one of "away", "offline" or "online"
         *   - "user_id", the user whose status changed
         */
        break;

    case 'post_deleted':
        /*
         * Sent when a post gets deleted by a user.
         */
        break;

    case 'channel_created':
        /*
         *
         */
        break;

    case 'channel_deleted':
        /*
         *
         */
        break;

    case 'direct_added':
        /*
         * Sent when a new direct channel is created for the user.
         * "data" contains:
         *   - "teammate_id", the user on the other side of the direct channel
         */
        break;

    case 'group_added':
        /*
         *
         */
        break;

    case 'added_to_team':
        /*
         *
         */
        break;

    case 'new_user':
        /*
         * Sent when there's a new user on the server.
         * "data" contains:
         *   - "user_id", for the new user
         */
        break;

    case 'leave_team':
        /*
         *
         */
        break;

    case 'update_team':
        /*
         *
         */
        break;

    case 'user_added':
        /*
         * Sent when a user is added to a team.
         * "data" contains:
         *   - "team_id", the team the channel's in
         *   - "user_id", the added user
         */
        break;

    case 'user_removed':
        /*
         * Sent when a user leaves a channel.
         * "data" contains:
         *   - "user_id", who left
         *   - "remover_id", to indicate who left (usually, but not always,
         *     the same as "user_id")
         */
        break;

    case 'preference_changed':
        /*
         *
         */
        break;

    case 'preferences_changed':
        /*
         * Sent when ?
         * "data" contains:
         *   - "preferences", an array of objects containing:
         *     - "user_id", id of another user indicating ...
         *     - "category", which can be one of "direct_channel_show", ...
         *     - "name", ...
         *     - "value", ...
         */
        break;

    case 'preferences_deleted':
        /*
         *
         */
        break;

    case 'ephemeral_message':
        /*
         * Message sent just to user, usually in response to a command, or
         * when trying to do something that the server might not allow. (For
         * example, trying to do @here/@channel when > 1k users present.)
         */
        break;

    case 'reaction_added':
        /*
         * Sent when a post has a reaction added to it.
         * "data" contains:
         *   - "user_id", who added the reaction
         *   - "post_id", the post the reaction was added to
         *   - "emoji_name", the reaction placed on the post
         *   - "create_at", the time it was added
         */
        break;

    case 'memberrole_updated':
        /*
         *
         */
        break;

    case 'webrtc':
        /*
         *
         */
        break;

    case 'authentication_challenge':
        /*
         *
         */
        break;

    case 'reaction_removed':
        /*
         *
         */
        break;

    case 'response':
        /*
         *
         */
        break;

    case 'user_updated':
        /*
         *
         */
        break;

    case 'emoji_added':
        /*
         *
         */
        break;

    default:
        throw new VError('UNRECOGNIZED MESSAGE TYPE: %j', obj);
    }

    self.emit('special', obj);
};

MattermostClient.prototype._pathObj = function () {
    var path = '/api/v4' + mod_path.join.apply(null, arguments);
    return {
        path: path,
        headers: {
            'Authorization': 'Bearer ' + this.token
        }
    };
};

MattermostClient.prototype.getTokenHeader = function () {
    assert.string(this.token, 'client should be logged in');

    return 'Bearer ' + this.token;
};


MattermostClient.prototype.listTeams = function (callback) {
    assert.func(callback, 'callback');

    var self = this;

    self.client.get(self._pathObj('/teams'),
        function (err, req, res, obj) {
        if (err) {
            callback(err);
            return;
        }

        callback(null, obj);
    });
};

MattermostClient.prototype.getTeamById = function (id, callback) {
    assert.string(id, 'id');
    assert.func(callback, 'callback');

    this.client.get(this._pathObj('/teams', id),
        function (err, req, res, obj) {
        callback(err, obj);
    });
};


MattermostClient.prototype.getTeamByName = function (name, callback) {
    assert.string(name, 'name');
    assert.func(callback, 'callback');

    this.client.get(this._pathObj('/teams/name', name),
        function (err, req, res, obj) {
        callback(err, obj);
    });
};


MattermostClient.prototype.listUsers = function (callback) {
    assert.func(callback, 'callback');

    this.client.get(this._pathObj('/users'),
        function (err, req, res, obj) {
        callback(err, obj);
    });
};


MattermostClient.prototype.getUserById = function (id, callback) {
    assert.string(id, 'id');
    assert.func(callback, 'callback');

    this.client.get(this._pathObj('/users', id),
        function (err, req, res, obj) {
        callback(err, obj);
    });
};


MattermostClient.prototype.getUserByName = function (username, callback) {
    assert.string(username, 'username');
    assert.func(callback, 'callback');

    this.client.get(this._pathObj('/users/username', username),
        function (err, req, res, obj) {
        callback(err, obj);
    });
};


MattermostClient.prototype.searchUsers =
    function searchUsers(params, callback) {
    assert.object(params, 'params');
    assert.string(params.term, 'params.term');
    assert.func(callback, 'callback');

    this.client.post(this._pathObj('/users/search'), params,
        function (err, req, res, obj) {
        callback(err, obj);
    });
};


MattermostClient.prototype.addUserToChannel =
    function addUserToChannel(channel, user, callback) {
    assert.string(channel, 'channel');
    assert.string(user, 'user');
    assert.func(callback, 'callback');

    var body = {
        user_id: user
    };

    this.client.post(this._pathObj('/channels', channel, 'members'), body,
        function (err, req, res, obj) {
        callback(err, obj);
    });
};


MattermostClient.prototype.removeUserFromChannel =
    function removeUserFromChannel(channel, user, callback) {
    assert.string(channel, 'channel');
    assert.string(user, 'user');
    assert.func(callback, 'callback');

    this.client.delete(this._pathObj('/channels', channel, 'members', user),
        function (err, req, res, obj) {
        callback(err, obj);
    });
};


MattermostClient.prototype.joinChannel =
    function joinChannel(channel, callback) {
    assert.object(this.user, 'must be logged in');
    this.addUserToChannel(channel, this.user.id, callback);
};


MattermostClient.prototype.leaveChannel =
    function joinChannel(channel, callback) {
    assert.object(this.user, 'must be logged in');
    this.removeUserFromChannel(channel, this.user.id, callback);
};


MattermostClient.prototype.getChannelByName =
    function (teamId, name, callback) {
    assert.string(teamId, 'teamId');
    assert.string(name, 'name');
    assert.func(callback, 'callback');

    this.client.get(this._pathObj('/teams', teamId, 'channels/name', name),
        function (err, req, res, obj) {
        callback(err, obj);
    });
};


MattermostClient.prototype.getChannelById = function (id, callback) {
    assert.string(id, 'id');
    assert.func(callback, 'callback');

    this.client.get(this._pathObj('/channels', id),
        function (err, req, res, obj) {
        callback(err, obj);
    });
};


MattermostClient.prototype.getChannelsForUser = function (uid, tid, callback) {
    assert.string(uid, 'uid');
    assert.string(tid, 'tid');
    assert.func(callback, 'callback');

    this.client.get(this._pathObj(
        '/users', uid, 'teams', tid, 'channels'),
        function (err, req, res, obj) {
        callback(err, obj);
    });
};


MattermostClient.prototype.getPostsForChannel = function (channel, callback) {
    assert.string(channel, 'channel');
    assert.func(callback, 'callback');

    this.client.get(this._pathObj(
        '/channels', channel, 'posts'),
        function (err, req, res, obj) {
        callback(err, obj);
    });
};


MattermostClient.prototype.createPost = function (room, msg, callback) {
    assert.string(room, 'room');
    assert.string(msg, 'msg');
    assert.func(callback, 'callback');

    this.client.post(this._pathObj('/posts'), {
        channel_id: room,
        message: msg,
        root_id: '',
        file_ids: []
    }, function (err, req, res, obj) {
        callback(err, obj);
    });
};

module.exports = {
    Client: MattermostClient
};