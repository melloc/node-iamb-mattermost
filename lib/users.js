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
var LOMStream = require('lomstream').LOMStream;
var mod_taiga = require('taiga');

// --- Globals

var FETCH_USER_LIMIT = 200;


// --- Internal helpers

function fetchUsers(client, lobj, _, callback) {
    client.listUsers({
        per_page: lobj.limit,
        page: Math.ceil(lobj.offset / lobj.limit)
    }, function (err, users) {
        if (err) {
            callback(err);
            return;
        }

        callback(null, {
            done: (users.length === 0),
            results: users
        });
    });
}

function compareUserID(a, b) {
    var ai = a.mmu_id;
    var bi = b.mmu_id;

    if (ai < bi) {
        return (-1);
    } else if (ai === bi) {
        return (0);
    } else {
        return (1);
    }
}

function compareUserName(a, b) {
    var au = a.mmu_username;
    var bu = b.mmu_username;

    if (au < bu) {
        return (-1);
    } else if (au === bu) {
        return (0);
    } else {
        return (1);
    }
}

function MattermostUser(id) {
    this.mmu_id = id;
    this.mmu_username = null;
    this.mmu_nickname = null;
    this.mmu_unode = null;
    this.mmu_nnode = null;
}

MattermostUser.prototype.update = function (data) {
    assert.object(data, 'data');
    assert.equal(data.id, this.mmu_id, 'data.id === this.mmu_id');

    this.mmu_nickname = data.nickname;
    this.mmu_username = data.username;
};

MattermostUser.prototype.id = function () {
    return this.mmu_id;
};

MattermostUser.prototype.getDisplayName = function () {
    if (this.mmu_nickname !== null && this.mmu_nickname !== '') {
        return this.mmu_nickname;
    } else {
        return this.mmu_username;
    }
};

// --- Exports


/**
 * Track user information as it's requested/becomes available.
 */
function MattermostUserDB(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.client, 'opts.client');

    this.mud_client = opts.client;

    this.mud_uids = new mod_taiga.AVLTree({ compare: compareUserID });
    this.mud_name = new mod_taiga.AVLTree({ compare: compareUserName });
}


MattermostUserDB.prototype.getUserById = function getUserById(id) {
    assert.string(id, 'id');
    var tmpu = new MattermostUser(id);
    var user = this.mud_uids.find(tmpu);
    if (user === null) {
        return null;
    }
    return user.value();
};


MattermostUserDB.prototype.getUserByName = function getUserByName(name) {
    assert.string(name, 'name');
    var tmpu = new MattermostUser(null);
    tmpu.mmu_username = name;
    var user = this.mud_name.find(tmpu);
    if (user === null) {
        return null;
    }
    return user.value();
};

MattermostUserDB.prototype.getUser = function getUser(id, nickname) {
    var user = this.getUserById(id);
    if (user !== null) {
        return user;
    }

    user = new MattermostUser(id);
    user.mmu_nickname = nickname;
    user.mmu_unode = this.mud_uids.insert(user);

    this._fillIn(user);

    return user;
};

MattermostUserDB.prototype.loadAllUsers = function loadAllUsers(callback) {
    var self = this;

    var lom = new LOMStream({
        limit: FETCH_USER_LIMIT,
        offset: true,
        fetch: fetchUsers,
        fetcharg: self.mud_client
    });

    lom.on('error', callback);

    lom.on('readable', function () {
        var data, user;

        for (;;) {
            data = lom.read(1);
            if (data === null) {
                return;
            }

            user = new MattermostUser(data.id);
            user.update(data);

            user.mmu_unode = self.mud_uids.insert(user);
            user.mmu_nnode = self.mud_name.insert(user);
        }
    });

    lom.on('end', callback);
};


MattermostUserDB.prototype._fillIn = function (user) {
    assert.object(user, 'user');

    var self = this;

    function tryFill() {
        self.mud_client.getUserById(user.mmu_id, function (err, data) {
            if (err) {
                setImmediate(tryFill);
                return;
            }

            user.update(data);

            if (user.mmu_nnode === null) {
                user.mmu_nnode = self.mud_name.insert(user);
            }
        });
    }

    setImmediate(tryFill);
};

module.exports = MattermostUserDB;
