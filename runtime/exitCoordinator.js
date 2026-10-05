'use strict';

// One authority for an exit attempt. A cancelled ID is never reusable, including
// after a retry or a renderer reload. Repeated Close does not extend the deadline.
function createExitCoordinator({ request, cancel, complete, setTimer = setTimeout, clearTimer = clearTimeout }) {
    let nextId = 0;
    let pending = null;
    let committed = false;
    function finish(id, error) {
        if (!pending || pending.id !== id || committed) return false;
        const attempt = pending;
        pending = null;
        clearTimer(attempt.timer);
        if (error) cancel(id, error);
        else { committed = true; complete(attempt.restart); }
        return true;
    }
    return {
        request(restart = false) {
            if (committed) return null;
            if (pending) { pending.restart ||= restart; return pending.id; }
            const id = ++nextId;
            pending = { id, restart, timer: setTimer(() => finish(id,
                'Local state has not finished saving. Sail stayed open; retry closing.'), 5000) };
            request(id);
            return id;
        },
        fail(id, message) { return finish(id, message || 'Local changes were not saved. Sail stayed open; retry closing.'); },
        succeed(id) { return finish(id); }
    };
}

module.exports = { createExitCoordinator };
