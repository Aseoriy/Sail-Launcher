#define _GNU_SOURCE
#ifndef __x86_64__
#error "Sail native protocol v1 currently targets Linux x64 only."
#endif
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <unistd.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <limits.h>
#include <stddef.h>

/* glibc before 2.36 (Ubuntu 22.04, the oldest build machine) does not declare P_PIDFD. The kernel value has been 3 since
   waitid learned pidfds (Linux 5.4), and newer glibc declares the same value, so this is safe everywhere. */
#ifndef P_PIDFD
#define P_PIDFD 3
#endif

#define PROTOCOL 1
#define MAX_PACKET 131072
#define MAX_ARGS 128
#define MAX_CHILDREN 4096
#define STOP_GRACE_MS 1500
#define STOP_LIMIT_MS 6000
extern char **environ;

struct child { pid_t pid; int fd; int term_sent; int kill_sent; };
static struct child children[MAX_CHILDREN];
static size_t child_count;
static char *session_id, *nonce, *executable, *working_directory;
static char *game_argv[MAX_ARGS + 2];
static char boot_id[64], namespace_id[64], start_ticks[40];
static uint64_t exe_dev, exe_ino, exe_size, exe_mtime, cwd_dev, cwd_ino;
static int directory_fd = -1, executable_fd = -1, working_fd = -1, listener = -1;
static pid_t root_pid;
static int root_exited, root_code, root_signal, exec_errno, tracking_error, receipt_error;
static int committed, exec_succeeded, terminal, stopping;
static int script_launch;
static int log_fd = -1, output_fd = -1;
static size_t log_size;
static uint64_t sequence, began_ms, elapsed_ms, stop_ms, last_receipt_ms;
static const char *phase = "starting";

static uint64_t monotonic_ms(void) {
    struct timespec time;
    if (clock_gettime(CLOCK_MONOTONIC, &time)) _exit(70);
    return (uint64_t)time.tv_sec * 1000 + (uint64_t)time.tv_nsec / 1000000;
}
static int pidfd_open_owned(pid_t pid) { return syscall(SYS_pidfd_open, pid, 0); }
static int signal_handle(int fd, int signal_number) { return syscall(SYS_pidfd_send_signal, fd, signal_number, NULL, 0); }
static int read_exact(int fd, void *buffer, size_t size) {
    char *p = buffer;
    while (size) { ssize_t n = read(fd, p, size); if (n < 0 && errno == EINTR) continue; if (n <= 0) return -1; p += n; size -= (size_t)n; }
    return 0;
}
static int write_exact(int fd, const void *buffer, size_t size) {
    const char *p = buffer;
    while (size) { ssize_t n = write(fd, p, size); if (n < 0 && errno == EINTR) continue; if (n <= 0) return -1; p += n; size -= (size_t)n; }
    return 0;
}
static int read_text(const char *file, char *buffer, size_t size) {
    int fd = open(file, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    ssize_t n = read(fd, buffer, size - 1); int saved = errno; close(fd); errno = saved;
    if (n <= 0 || (size_t)n == size - 1) return -1;
    buffer[n] = 0; while (n > 0 && (buffer[n - 1] == '\n' || buffer[n - 1] == ' ')) buffer[--n] = 0;
    return 0;
}
static int identity(void) {
    char stat[4096];
    if (read_text("/proc/sys/kernel/random/boot_id", boot_id, sizeof(boot_id)) || read_text("/proc/self/stat", stat, sizeof(stat))) return -1;
    ssize_t n = readlink("/proc/self/ns/pid", namespace_id, sizeof(namespace_id) - 1); if (n <= 0) return -1; namespace_id[n] = 0;
    char *cursor = strrchr(stat, ')'); if (!cursor) return -1; cursor += 2;
    for (int field = 3; field < 22; field++) { cursor = strchr(cursor, ' '); if (!cursor) return -1; cursor++; }
    n = strcspn(cursor, " "); if (n <= 0 || (size_t)n >= sizeof(start_ticks)) return -1;
    memcpy(start_ticks, cursor, (size_t)n); start_ticks[n] = 0; return 0;
}
static int decimal(const char *value, uint64_t *out) {
    if (!value || !*value || strspn(value, "0123456789") != strlen(value)) return -1;
    errno = 0; char *end; unsigned long long number = strtoull(value, &end, 10);
    if (errno || *end) return -1;
    *out = number; return 0;
}
static int canonical_open(const char *name, int flags) {
    if (!name || name[0] != '/' || strlen(name) >= PATH_MAX) { errno = EINVAL; return -1; }
    if (!strcmp(name, "/")) return open("/", flags | O_CLOEXEC | O_NOFOLLOW);
    char copy[PATH_MAX]; strcpy(copy, name + 1);
    int parent = open("/", O_PATH | O_DIRECTORY | O_CLOEXEC); if (parent < 0) return -1;
    char *part = copy;
    for (;;) {
        char *slash = strchr(part, '/'); if (slash) *slash = 0;
        if (!*part || !strcmp(part, ".") || !strcmp(part, "..")) { close(parent); errno = EINVAL; return -1; }
        int next = openat(parent, part, (slash ? O_PATH | O_DIRECTORY : flags) | O_NOFOLLOW | O_CLOEXEC);
        int saved = errno; close(parent); errno = saved; if (next < 0) return -1;
        if (!slash) return next;
        parent = next; part = slash + 1;
    }
}
static int validate_descriptors(void) {
    struct stat file, cwd;
    if (fstat(executable_fd, &file) || fstat(working_fd, &cwd)) return -1;
    uint64_t mtime = (uint64_t)file.st_mtim.tv_sec * 1000 + ((uint64_t)file.st_mtim.tv_nsec + 500000) / 1000000;
    if (!S_ISREG(file.st_mode) || !S_ISDIR(cwd.st_mode) || (uint64_t)file.st_dev != exe_dev || (uint64_t)file.st_ino != exe_ino
        || (uint64_t)file.st_size != exe_size || mtime != exe_mtime || (uint64_t)cwd.st_dev != cwd_dev || (uint64_t)cwd.st_ino != cwd_ino) { errno = ESTALE; return -1; }
    return 0;
}
static int validate_script_path(void) {
    int fd = canonical_open(executable, O_RDONLY);
    if (fd < 0) return -1;
    struct stat selected, retained;
    int result = fstat(fd, &selected) || fstat(executable_fd, &retained);
    if (!result && (selected.st_dev != retained.st_dev || selected.st_ino != retained.st_ino
        || selected.st_size != retained.st_size || selected.st_mtim.tv_sec != retained.st_mtim.tv_sec
        || selected.st_mtim.tv_nsec != retained.st_mtim.tv_nsec)) { errno = ESTALE; result = -1; }
    int saved = errno; close(fd); errno = saved;
    return result;
}
#include "proton-clock.h"
static int snapshot(char *buffer, size_t size, int durable) {
    char game[512] = "";
    if (game_image) snprintf(game,sizeof(game),",\"game\":{\"method\":\"%s\",\"targetDev\":\"%llu\",\"targetIno\":\"%llu\",\"confirmed\":%s,\"elapsedMs\":%llu,\"startOffsetMs\":%llu,\"activeProcesses\":%zu,\"error\":%d}",
        game_wine ? "pe-image-wine-v1" : "pe-image-v1", (unsigned long long)game_dev,(unsigned long long)game_ino,game_confirmed ? "true" : "false",
        (unsigned long long)game_elapsed,(unsigned long long)game_start_offset,terminal ? 0 : game_active,game_error);
    return snprintf(buffer, size,
        "{\"protocol\":1,\"sessionId\":\"%s\",\"sequence\":%llu,\"bootId\":\"%s\",\"pidNamespace\":\"%s\",\"supervisorPid\":%d,\"supervisorStartTicks\":\"%s\","
        "\"phase\":\"%s\",\"execSucceeded\":%s,\"rootPid\":%d,\"rootExited\":%s,\"rootCode\":%d,\"rootSignal\":%d,\"ownedChildren\":%zu,"
        "\"elapsedMs\":%llu,\"clock\":\"CLOCK_MONOTONIC\",\"terminal\":%s,\"execErrno\":%d,\"trackingErrno\":%d,\"receiptErrno\":%d,\"durable\":%s,\"executionKind\":\"%s\"%s}\n",
        session_id, (unsigned long long)sequence, boot_id, namespace_id, getpid(), start_ticks, phase,
        exec_succeeded ? "true" : "false", root_pid, root_exited ? "true" : "false", root_code, root_signal, child_count,
        (unsigned long long)elapsed_ms, terminal ? "true" : "false", exec_errno, tracking_error, receipt_error, durable ? "true" : "false", script_launch ? "script-native-path" : "elf", game);
}
static int persist_receipt(void) {
    char data[2048], temporary[64];
    snprintf(temporary, sizeof(temporary), ".receipt-%llu.tmp", (unsigned long long)(++sequence));
    int fd = openat(directory_fd, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0) { receipt_error = errno; return -1; }
    int previous = receipt_error; receipt_error = 0;
    int n = snapshot(data, sizeof(data), 1);
    int ok = n > 0 && (size_t)n < sizeof(data) && !write_exact(fd, data, (size_t)n) && !fsync(fd);
    int saved = errno; close(fd);
    if (ok && renameat(directory_fd, temporary, directory_fd, "receipt.json") == 0 && fsync(directory_fd) == 0) { last_receipt_ms = monotonic_ms(); return 0; }
    if (ok) saved = errno;
    unlinkat(directory_fd, temporary, 0); receipt_error = saved ? saved : previous ? previous : EIO; return -1;
}
static int load_config(void) {
    uint8_t size_bytes[4]; if (read_exact(STDIN_FILENO, size_bytes, 4)) return -1;
    uint32_t size = (uint32_t)size_bytes[0] | (uint32_t)size_bytes[1] << 8 | (uint32_t)size_bytes[2] << 16 | (uint32_t)size_bytes[3] << 24;
    if (!size || size > MAX_PACKET) return -1;
    char *data = calloc(1, size + 1); if (!data || read_exact(STDIN_FILENO, data, size) || data[size - 1]) return -1;
    char *fields[MAX_ARGS + 142]; size_t count = 0, offset = 0;
    while (offset < size) { if (count >= MAX_ARGS + 142) return -1; fields[count++] = data + offset; offset += strlen(data + offset) + 1; }
    if (count < 13 || strcmp(fields[0], "SAIL_NATIVE_1") || strlen(fields[1]) != 36 || strspn(fields[1], "0123456789abcdef-") != 36
        || strlen(fields[2]) != 64 || strspn(fields[2], "0123456789abcdef") != 64) return -1;
    uint64_t argc;
    if (decimal(fields[6], &exe_dev) || decimal(fields[7], &exe_ino) || decimal(fields[8], &exe_size) || decimal(fields[9], &exe_mtime)
        || decimal(fields[10], &cwd_dev) || decimal(fields[11], &cwd_ino) || decimal(fields[12], &argc) || argc > MAX_ARGS || count < argc + 13) return -1;
    if (count > argc + 13 && game_config(fields + argc + 13, count - argc - 13)) return -1;
    session_id = fields[1]; nonce = fields[2]; executable = fields[4]; working_directory = fields[5];
    directory_fd = canonical_open(fields[3], O_RDONLY | O_DIRECTORY);
    struct stat directory; if (directory_fd < 0 || fstat(directory_fd, &directory) || directory.st_uid != getuid() || (directory.st_mode & 077)) return -1;
    executable_fd = canonical_open(executable, O_RDONLY); working_fd = canonical_open(working_directory, O_PATH | O_DIRECTORY);
    if (executable_fd >= 0) {
        unsigned char header[2];
        script_launch = pread(executable_fd, header, sizeof(header), 0) == sizeof(header) && header[0] == '#' && header[1] == '!';
    }
    if (executable_fd < 0 || working_fd < 0 || validate_descriptors()) { exec_errno = errno; }
    game_argv[0] = executable; for (size_t i = 0; i < argc; i++) game_argv[i + 1] = fields[i + 13]; game_argv[argc + 1] = NULL;
    return 0;
}

/* A single waiter owns every child. No SIGCHLD handler or numeric signal path. */
static int retain_child(pid_t pid) {
    for (size_t i = 0; i < child_count; i++) if (children[i].pid == pid) return 0;
    if (child_count == MAX_CHILDREN) { errno = EOVERFLOW; return -1; }
    int fd = pidfd_open_owned(pid); if (fd < 0) return -1;
    siginfo_t info = {0};
    if (waitid(P_PIDFD, (id_t)fd, &info, WEXITED | WNOHANG | WNOWAIT)) { int saved = errno; close(fd); errno = saved; return -1; }
    children[child_count++] = (struct child){ .pid = pid, .fd = fd }; return 0;
}
static int discover_children(void) {
    char name[100], data[MAX_CHILDREN * 12 + 1];
    snprintf(name, sizeof(name), "/proc/self/task/%d/children", getpid());
    int fd = open(name, O_RDONLY | O_CLOEXEC); if (fd < 0) return -1;
    ssize_t n = read(fd, data, sizeof(data) - 1); int saved = errno; close(fd); errno = saved;
    if (n < 0) return -1;
    if ((size_t)n == sizeof(data) - 1) { errno = EOVERFLOW; return -1; }
    data[n] = 0; char *cursor = data;
    while (*cursor) {
        while (*cursor == ' ') cursor++;
        if (!*cursor) break;
        errno = 0; char *end; long pid = strtol(cursor, &end, 10);
        if (errno || end == cursor || pid <= 0 || pid > INT_MAX || (*end && *end != ' ')) { errno = EPROTO; return -1; }
        if (retain_child((pid_t)pid)) return -1;
        cursor = end;
    }
    return 0;
}
static void observe_children(void) {
    if (discover_children() && !tracking_error) tracking_error = errno;
    uint64_t now = monotonic_ms();
    for (size_t i = 0; i < child_count;) {
        struct child *child = &children[i]; siginfo_t info = {0};
        if (waitid(P_PIDFD, (id_t)child->fd, &info, WEXITED | WNOHANG | WNOWAIT)) {
            if (!tracking_error) tracking_error = errno;
            i++; continue;
        }
        if (info.si_pid) {
            if (child->pid == root_pid) {
                root_exited = 1;
                if (info.si_code == CLD_EXITED) root_code = info.si_status;
                else root_signal = info.si_status;
            }
            if (waitid(P_PIDFD, (id_t)child->fd, &info, WEXITED | WNOHANG)) {
                if (!tracking_error) tracking_error = errno;
                i++; continue;
            }
            close(child->fd); children[i] = children[--child_count]; continue;
        }
        if (stopping) {
            int number = now - stop_ms >= STOP_GRACE_MS ? SIGKILL : SIGTERM;
            int *sent = number == SIGKILL ? &child->kill_sent : &child->term_sent;
            if (!*sent) {
                if (signal_handle(child->fd, number) && errno != ESRCH) { if (!tracking_error) tracking_error = errno; }
                else *sent = 1;
            }
        }
        i++;
    }
    if (exec_succeeded && !tracking_error) elapsed_ms = now - began_ms;
    game_observe(now);
    if (!child_count && committed) {
        siginfo_t info = {0}; errno = 0;
        int result = waitid(P_ALL, 0, &info, WEXITED | WNOHANG | WNOWAIT);
        if (result < 0 && errno == ECHILD && !tracking_error) {
            terminal = 1; phase = exec_succeeded ? "completed" : "launch-failed"; return;
        }
        if (result < 0 && errno != ECHILD && !tracking_error) tracking_error = errno;
    }
    if (stopping && now - stop_ms >= STOP_LIMIT_MS && !tracking_error) tracking_error = ETIMEDOUT;
    phase = tracking_error ? "tracking-lost" : stopping ? "stopping" : root_exited ? "root-exited-descendants-running" : "running";
}
/* Continue draining after disk errors. Two private 1 MiB segments retain the
 * most recent output. Logging
 * failures never change process tracking, Stop or the gameplay clock. */
static void drain_output(void) {
    if (output_fd < 0) return;
    char buffer[8192]; size_t budget = 65536;
    while (budget) {
        ssize_t count = read(output_fd, buffer, budget < sizeof(buffer) ? budget : sizeof(buffer));
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) {
            if (!count) { close(output_fd); output_fd = -1; }
            break;
        }
        budget -= (size_t)count;
        if (log_fd < 0) continue;
        if (log_size + (size_t)count > 1048576) {
            close(log_fd); log_fd = -1;
            if (renameat(directory_fd, "launch.log", directory_fd, "launch.log.1") == 0)
                log_fd = openat(directory_fd, "launch.log", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
            log_size = 0;
        }
        if (log_fd >= 0) {
            if (write_exact(log_fd, buffer, (size_t)count)) { close(log_fd); log_fd = -1; }
            else log_size += (size_t)count;
        }
    }
}
static void finish_log(void) {
    drain_output();
    if (log_fd >= 0) { int ignored = fsync(log_fd); (void)ignored; close(log_fd); log_fd = -1; }
    if (output_fd >= 0) { close(output_fd); output_fd = -1; }
}
static void launch_root(void) {
    if (exec_errno || validate_descriptors() || (game_image && game_validate_file())) {
        if (!exec_errno) exec_errno = errno;
        terminal = 1; phase = "launch-failed"; return;
    }
    int gate[2], failure[2];
    if (pipe2(gate, O_CLOEXEC)) { exec_errno = errno; terminal = 1; phase = "launch-failed"; return; }
    if (pipe2(failure, O_CLOEXEC)) { exec_errno = errno; close(gate[0]); close(gate[1]); terminal = 1; phase = "launch-failed"; return; }
    int output[2] = {-1, -1};
    /* UMU installers have no gameplay image clock, but need the same bounded
     * diagnostics. The main gateway supplies only validated UMU variables. */
    if (game_image || (getenv("WINEPREFIX") && getenv("PROTONPATH"))) {
        log_fd = openat(directory_fd, "launch.log", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
        if (log_fd >= 0 && pipe2(output, O_CLOEXEC) == 0 && fcntl(output[0], F_SETFL, O_NONBLOCK) == 0) output_fd = output[0];
        else {
            if (log_fd >= 0) close(log_fd);
            if (output[0] >= 0) close(output[0]);
            if (output[1] >= 0) close(output[1]);
            log_fd = -1; output[0] = output[1] = -1;
        }
    }
    root_pid = fork();
    if (!root_pid) {
        close(gate[1]); close(failure[0]);
        char commit;
        if (read_exact(gate[0], &commit, 1) || commit != 'C') _exit(125);
        close(gate[0]);
        int null_fd = open("/dev/null", O_RDWR);
        int destination = output[1] >= 0 ? output[1] : null_fd;
        if (null_fd < 0 || dup2(null_fd, 0) < 0 || dup2(destination, 1) < 0 || dup2(destination, 2) < 0 || fchdir(working_fd)) goto exec_failed;
        if (null_fd > 2) close(null_fd);
        if (output[0] >= 0) close(output[0]);
        if (output[1] >= 0) close(output[1]);
        if (log_fd >= 0) close(log_fd);
        if (script_launch) {
            /* Accepted normal Linux pathname semantics: a concurrent path
             * replacement after this check is not an inode-pinned launch. */
            if (validate_descriptors() || validate_script_path()) goto exec_failed;
            execve(executable, game_argv, environ);
        } else execveat(executable_fd, "", game_argv, environ, AT_EMPTY_PATH);
exec_failed:;
        int error = errno; write_exact(failure[1], &error, sizeof(error)); _exit(127);
    }
    close(gate[0]); close(failure[1]);
    if (output[1] >= 0) close(output[1]);
    if (root_pid < 0) {
        exec_errno = errno; close(gate[1]); close(failure[0]); terminal = 1; phase = "launch-failed"; return;
    }
    if (retain_child(root_pid)) {
        exec_errno = errno; close(gate[1]); close(failure[0]);
        /* The uncommitted child can only exit; never signal an unowned PID. */
        while (waitpid(root_pid, NULL, 0) < 0 && errno == EINTR) {}
        root_exited = 1; terminal = 1; phase = "launch-failed"; return;
    }
    began_ms = monotonic_ms();
    if (write_exact(gate[1], "C", 1)) exec_errno = errno;
    close(gate[1]);
    struct pollfd wait = { .fd = failure[0], .events = POLLIN | POLLHUP };
    int polled; do { polled = poll(&wait, 1, 3000); } while (polled < 0 && errno == EINTR);
    if (polled > 0) {
        int error = 0; ssize_t count; do { count = read(failure[0], &error, sizeof(error)); } while (count < 0 && errno == EINTR);
        if (count == 0 && !exec_errno) exec_succeeded = 1;
        else if (count == sizeof(error)) exec_errno = error;
        else tracking_error = EPROTO;
    } else tracking_error = polled == 0 ? ETIMEDOUT : errno;
    close(failure[0]);
    phase = tracking_error ? "tracking-lost" : exec_succeeded ? "running" : "starting";
}
static int open_listener(void) {
    listener = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0); if (listener < 0) return -1;
    struct sockaddr_un address = { .sun_family = AF_UNIX };
    int n = snprintf(address.sun_path + 1, sizeof(address.sun_path) - 1, "sail-native-v1-%s", session_id);
    if (n <= 0 || (size_t)n >= sizeof(address.sun_path) - 1) { errno = EINVAL; return -1; }
    if (bind(listener, (struct sockaddr *)&address, (socklen_t)(offsetof(struct sockaddr_un, sun_path) + 1 + n)) || listen(listener, 8)) return -1;
    return 0;
}
static int handle_connection(void) {
    int fd = accept4(listener, NULL, NULL, SOCK_CLOEXEC); if (fd < 0) return 0;
    struct ucred peer; socklen_t size = sizeof(peer);
    if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &peer, &size) || peer.uid != getuid()) { close(fd); return 0; }
    char request[100]; size_t used = 0; uint64_t deadline = monotonic_ms() + 1000;
    while (used < sizeof(request) - 1 && monotonic_ms() < deadline) {
        struct pollfd wait = { .fd = fd, .events = POLLIN };
        uint64_t now = monotonic_ms();
        if (now >= deadline) break;
        int result = poll(&wait, 1, (int)(deadline - now));
        if (result <= 0) break;
        ssize_t n = read(fd, request + used, sizeof(request) - 1 - used); if (n <= 0) break;
        used += (size_t)n; if (memchr(request, '\n', used)) break;
    }
    request[used] = 0;
    char *space = strchr(request, ' ');
    if (!space || strlen(space + 1) != 65 || space[65] != '\n' || memcmp(space + 1, nonce, 64)) { close(fd); return 0; }
    *space = 0; int acknowledged = 0;
    if (!strcmp(request, "COMMIT") && !committed && !terminal) {
        /* Persist the transition before releasing any executable child. */
        committed = 1;
        if (persist_receipt()) { committed = 0; }
        else launch_root();
    } else if (!strcmp(request, "STOP") && !terminal) {
        if (!committed) { terminal = 1; phase = "launch-failed"; exec_errno = ECANCELED; }
        else if (!stopping) { stopping = 1; stop_ms = monotonic_ms(); }
    } else if (!strcmp(request, "ACK") && terminal && !receipt_error) acknowledged = 1;
    else if (strcmp(request, "STATUS") && strcmp(request, "COMMIT") && strcmp(request, "STOP")) { close(fd); return 0; }
    if (committed && !terminal) observe_children();
    drain_output(); if (terminal) finish_log();
    if (persist_receipt()) acknowledged = 0;
    char reply[2048]; int count = snapshot(reply, sizeof(reply), !receipt_error);
    write_exact(fd, reply, (size_t)count); close(fd); return acknowledged;
}
static int probe(void) {
    if (prctl(PR_SET_CHILD_SUBREAPER, 1) || signal(SIGCHLD, SIG_DFL) == SIG_ERR) return 71;
    int fd = pidfd_open_owned(getpid()); if (fd < 0 || signal_handle(fd, 0)) return 72;
    siginfo_t info = {0}; errno = 0;
    int result = waitid(P_PIDFD, (id_t)fd, &info, WEXITED | WNOHANG | WNOWAIT); close(fd);
    if (result != -1 || errno != ECHILD) return 73;
    puts("{\"protocol\":1,\"arch\":\"x64\",\"subreaper\":true,\"pidfd\":true,\"clock\":\"CLOCK_MONOTONIC\",\"scripts\":\"native-path-v1\",\"windowsTracking\":\"pe-image-v1\",\"wineTracking\":\"pe-image-wine-v1\"}"); return 0;
}
int main(int argc, char **argv) {
    if (argc == 2 && !strcmp(argv[1], "--probe")) return probe();
    if (argc != 2 || strcmp(argv[1], "--session")) return 64;
    signal(SIGPIPE, SIG_IGN); signal(SIGCHLD, SIG_DFL);
    alarm(15); if (load_config()) return 65; alarm(0);
    if (setsid() < 0 && getsid(0) != getpid()) return 66;
    if (prctl(PR_SET_CHILD_SUBREAPER, 1) || identity() || open_listener()) return 67;
    if (persist_receipt()) return 68;
    char data[2048]; int count = snapshot(data, sizeof(data), 1);
    if (write_exact(STDOUT_FILENO, data, (size_t)count)) return 69;
    int null_fd = open("/dev/null", O_RDWR | O_CLOEXEC);
    if (null_fd < 0 || dup2(null_fd, 0) < 0 || dup2(null_fd, 1) < 0 || dup2(null_fd, 2) < 0) return 69;
    if (null_fd > 2) close(null_fd);
    uint64_t commit_deadline = monotonic_ms() + 10000;
    uint64_t terminal_since = 0;
    for (;;) {
        drain_output();
        if (!committed && !terminal && monotonic_ms() >= commit_deadline) { terminal = 1; phase = "launch-failed"; exec_errno = ETIMEDOUT; }
        if (committed && !terminal) observe_children();
        if (monotonic_ms() - last_receipt_ms >= 250) persist_receipt();
        if (terminal && !receipt_error) {
            if (!terminal_since) terminal_since = monotonic_ms();
            if (monotonic_ms() - terminal_since >= 10000) { finish_log(); break; }
        }
        struct pollfd waits[2] = {{ .fd = listener, .events = POLLIN }, { .fd = output_fd, .events = POLLIN | POLLHUP }};
        int result = poll(waits, 2, 20);
        if (result > 0 && (waits[0].revents & POLLIN) && handle_connection()) break;
        if (result < 0 && errno != EINTR) { if (!tracking_error) tracking_error = errno; phase = "tracking-lost"; }
    }
    return 0;
}
