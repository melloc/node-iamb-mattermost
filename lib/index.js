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
var mod_util = require('util');

var MattermostMessage = require('./message');
var MattermostRoom = require('./room');
var MattermostUserDB = require('./users');
var RawMattermostClient = require('./raw');

// --- Exports

function MattermostClient(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.account, 'opts.account');
    assert.string(opts.account.team, 'opts.account.team');

    this.mmc_account = opts.account;
    this.mmc_client = new RawMattermostClient(opts);
    this.mmc_log = opts.log;

    this.mmc_team = null;
    this.mmc_user = null;

    this.mmc_cnames = {};
    this.mmc_dnames = {};

    this.mmc_ids = {};

    this.mmc_users = new MattermostUserDB({
        client: this.mmc_client
    });

    mod_mooremachine.FSM.call(this, 'init');
}
mod_util.inherits(MattermostClient, mod_mooremachine.FSM);

MattermostClient.prototype.state_init = function (S) {
    var self = this;

    S.on(this.mmc_client, 'connected', function (user) {
        self.mmc_user = user;

        S.gotoState('init.team');
    });
};

MattermostClient.prototype.state_init.team = function (S) {
    var self = this;

    self.mmc_client.getTeamByName(self.mmc_account.team, function (gErr, team) {
        if (gErr) {
            self.warn('failed to get team info');
            return;
        }

        self.mmc_team = team;

        S.gotoState('init.users');
    });
};

MattermostClient.prototype.state_init.users = function (S) {
    var self = this;

    self.mmc_users.loadAllUsers(function (uErr) {
        if (uErr) {
            /*
             * If we fail to load all users, log the reason why, but
             * continue on. We'll make sure to load information about
             * all of the users we have active DMs with, at least, and
             * continue fetching user information as we need it.
             */
            self.log.error(uErr, 'failed to load all users');
        }

        S.gotoState('init.channels');
    });
};

MattermostClient.prototype.state_init.channels = function (S) {
    var self = this;

    function loadChannel(channel) {
        var room = new MattermostRoom({
            client: self.mmc_client,
            users: self.mmc_users,
            channel: channel
        });

        self.mmc_ids[channel.id] = room;

        if (channel.type !== 'D') {
            self.mmc_cnames[room.mmr_alias] = room;
            return;
        }

        var other = channel.name.split('__').filter(function (uid) {
            return uid !== self.mmc_user.id;
        });
        assert.equal(other.length, 1, 'other.length === 1');

        room.mmr_other = self.mmc_users.getUser(other[0], null);
        self.mmc_dnames[other[0]] = room;
    }

    self.mmc_client.getChannelsForUser(self.mmc_user.id, self.mmc_team.id,
        function (lErr, channels) {
        if (lErr) {
            self.log.warn(lErr, 'failed to load channels');
            S.immediate(function () {
                S.gotoState('init.channels');
            });
            return;
        }

        channels.forEach(loadChannel);

        S.gotoState('ready');
    });
};

MattermostClient.prototype.state_ready = function (S) {
    var self = this;

    S.on(self.mmc_client, 'message', function (data, post) {
        if (!mod_jsprim.hasKey(self.mmc_ids, post.channel_id)) {
            // XXX: Should we try to load the channel id?
            self.mmc_log.warn({
                data: data,
                post: post
            }, 'received message for unknown channel');
            return;
        }

        var room = self.mmc_ids[post.channel_id];
        var speaker = self.mmc_users.getUser(post.user_id, data.sender_name);
        var message = new MattermostMessage(room, speaker, post);

        room.append(message);
    });

    self.emit('connected');
};

MattermostClient.prototype.getRoomByName = function (name) {
    if (!mod_jsprim.hasKey(this.mmc_cnames, name)) {
        return null;
    }

    var room = this.mmc_cnames[name];
    room._fetch();

    return room;
};

MattermostClient.prototype.getDirectByName = function (name) {
    var user = this.mmc_users.getUserByName(name);
    if (user === null) {
        return null;
    }

    if (!mod_jsprim.hasKey(this.mmc_dnames, user.id())) {
        return null;
    }

    var room = this.mmc_dnames[user.id()];
    room._fetch();

    return room;
};

var authConfigSchema = {
    id: 'auth:mattermost',
    type: 'object',
    required: [ 'url', 'team', 'username' ],
    properties: {
        'url': {
            type: 'string',
            pattern: '^https://'
        },
        'team': {
            type: 'string'
        },
        'username': {
            type: 'string'
        },
        'token': {
            type: 'string'
        },
        'password': {
            type: 'string'
        }
    }
};

module.exports = {
    Client: MattermostClient,
    authConfigSchema: authConfigSchema
};
