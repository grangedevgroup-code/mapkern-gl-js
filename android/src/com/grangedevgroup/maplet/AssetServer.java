package com.grangedevgroup.maplet;

import android.content.res.AssetFileDescriptor;
import android.content.res.AssetManager;
import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

final class AssetServer {
    private final AssetManager assets;
    private final String root;
    private final Map<String, byte[]> small = new ConcurrentHashMap<>();
    private ServerSocket socket;
    private volatile boolean running;

    AssetServer(AssetManager assets, String root) {
        this.assets = assets;
        this.root = root;
    }

    void start() {
        try {
            socket = new ServerSocket(0, 64, InetAddress.getByName("127.0.0.1"));
        } catch (IOException e) {
            throw new IllegalStateException("Could not open the local server", e);
        }
        running = true;
        Thread accept = new Thread(() -> {
            while (running) {
                try {
                    Socket client = socket.accept();
                    Thread worker = new Thread(() -> serve(client), "maplet-request");
                    worker.setDaemon(true);
                    worker.start();
                } catch (IOException e) {
                    if (!running) return;
                }
            }
        }, "maplet-server");
        accept.setDaemon(true);
        accept.start();
    }

    String url() {
        return "http://127.0.0.1:" + socket.getLocalPort() + "/";
    }

    void stop() {
        running = false;
        try {
            socket.close();
        } catch (IOException ignored) {
        }
    }

    private void serve(Socket client) {
        try (Socket s = client) {
            s.setSoTimeout(30000);
            InputStream in = new BufferedInputStream(s.getInputStream());
            OutputStream out = new BufferedOutputStream(s.getOutputStream(), 65536);
            while (true) {
                String request = readLine(in);
                if (request == null || request.isEmpty()) return;
                String[] parts = request.split(" ");
                if (parts.length < 2) return;
                String range = null;
                boolean close = false;
                for (String header = readLine(in); header != null && !header.isEmpty(); header = readLine(in)) {
                    int colon = header.indexOf(':');
                    if (colon < 0) continue;
                    String name = header.substring(0, colon).trim().toLowerCase(Locale.ROOT);
                    String value = header.substring(colon + 1).trim();
                    if (name.equals("range")) range = value;
                    else if (name.equals("connection") && value.equalsIgnoreCase("close")) close = true;
                }
                respond(out, parts[0], parts[1], range);
                out.flush();
                if (close) return;
            }
        } catch (IOException ignored) {
        }
    }

    private void respond(OutputStream out, String method, String target, String range) throws IOException {
        boolean head = method.equals("HEAD");
        if (!head && !method.equals("GET")) {
            status(out, "405 Method Not Allowed", "text/plain", 0, null);
            return;
        }
        String path = target;
        int query = path.indexOf('?');
        if (query >= 0) path = path.substring(0, query);
        path = URLDecoder.decode(path, "UTF-8");
        while (path.startsWith("/")) path = path.substring(1);
        if (path.contains("..")) {
            status(out, "404 Not Found", "text/plain", 0, null);
            return;
        }
        if (path.isEmpty() || path.endsWith("/")) path += "index.html";
        String asset = root + "/" + path;
        if (!exists(asset)) {
            if (exists(asset + "/index.html")) {
                String location = "/" + path + "/";
                out.write(("HTTP/1.1 301 Moved Permanently\r\nLocation: " + location
                    + "\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                return;
            }
            status(out, "404 Not Found", "text/plain", 0, null);
            return;
        }
        String type = contentType(path);
        AssetFileDescriptor fd = null;
        try {
            fd = assets.openFd(asset);
        } catch (FileNotFoundException compressed) {
            fd = null;
        }
        if (fd != null) {
            try {
                long length = fd.getLength();
                long[] span = span(range, length);
                if (span == null) {
                    unsatisfiable(out, length);
                    return;
                }
                long size = span[1] - span[0] + 1;
                status(out, range != null ? "206 Partial Content" : "200 OK", type, size,
                    range != null ? "bytes " + span[0] + "-" + span[1] + "/" + length : null);
                if (head) return;
                try (InputStream stream = fd.createInputStream()) {
                    skipFully(stream, span[0]);
                    copy(stream, out, size);
                }
            } finally {
                fd.close();
            }
            return;
        }
        byte[] body = small.get(asset);
        if (body == null) {
            try (InputStream stream = assets.open(asset)) {
                body = readAll(stream);
            }
            small.put(asset, body);
        }
        long[] span = span(range, body.length);
        if (span == null) {
            unsatisfiable(out, body.length);
            return;
        }
        int size = (int) (span[1] - span[0] + 1);
        status(out, range != null ? "206 Partial Content" : "200 OK", type, size,
            range != null ? "bytes " + span[0] + "-" + span[1] + "/" + body.length : null);
        if (!head) out.write(body, (int) span[0], size);
    }

    private boolean exists(String asset) {
        if (small.containsKey(asset)) return true;
        try (InputStream ignored = assets.open(asset)) {
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    private static long[] span(String range, long length) {
        if (range == null) return new long[] {0, Math.max(0, length - 1)};
        if (!range.startsWith("bytes=") || range.contains(",")) return null;
        String spec = range.substring(6).trim();
        int dash = spec.indexOf('-');
        if (dash < 0) return null;
        try {
            String from = spec.substring(0, dash).trim();
            String to = spec.substring(dash + 1).trim();
            long start;
            long end;
            if (from.isEmpty()) {
                long suffix = Long.parseLong(to);
                start = Math.max(0, length - suffix);
                end = length - 1;
            } else {
                start = Long.parseLong(from);
                end = to.isEmpty() ? length - 1 : Math.min(Long.parseLong(to), length - 1);
            }
            return start <= end && start < length ? new long[] {start, end} : null;
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static void status(OutputStream out, String status, String type, long length, String contentRange)
        throws IOException {
        StringBuilder head = new StringBuilder();
        head.append("HTTP/1.1 ").append(status).append("\r\n");
        head.append("Content-Type: ").append(type).append("\r\n");
        head.append("Content-Length: ").append(length).append("\r\n");
        if (contentRange != null) head.append("Content-Range: ").append(contentRange).append("\r\n");
        head.append("Accept-Ranges: bytes\r\n");
        head.append("Cache-Control: no-store\r\n");
        head.append("Access-Control-Allow-Origin: *\r\n");
        head.append("Connection: keep-alive\r\n\r\n");
        out.write(head.toString().getBytes(StandardCharsets.US_ASCII));
    }

    private static void unsatisfiable(OutputStream out, long length) throws IOException {
        out.write(("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */" + length
            + "\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
    }

    private static String contentType(String path) {
        String name = path.toLowerCase(Locale.ROOT);
        if (name.endsWith(".html")) return "text/html; charset=utf-8";
        if (name.endsWith(".js") || name.endsWith(".mjs")) return "text/javascript; charset=utf-8";
        if (name.endsWith(".css")) return "text/css; charset=utf-8";
        if (name.endsWith(".json") || name.endsWith(".map")) return "application/json; charset=utf-8";
        if (name.endsWith(".svg")) return "image/svg+xml";
        if (name.endsWith(".png")) return "image/png";
        if (name.endsWith(".webp")) return "image/webp";
        if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
        if (name.endsWith(".pbf") || name.endsWith(".mvt")) return "application/x-protobuf";
        if (name.endsWith(".woff2")) return "font/woff2";
        if (name.endsWith(".txt") || name.endsWith(".md")) return "text/plain; charset=utf-8";
        return "application/octet-stream";
    }

    private static String readLine(InputStream in) throws IOException {
        StringBuilder line = new StringBuilder();
        while (true) {
            int c = in.read();
            if (c < 0) return line.length() > 0 ? line.toString() : null;
            if (c == '\n') break;
            if (c != '\r') line.append((char) c);
            if (line.length() > 8192) return null;
        }
        return line.toString();
    }

    private static void skipFully(InputStream in, long count) throws IOException {
        while (count > 0) {
            long skipped = in.skip(count);
            if (skipped <= 0) {
                if (in.read() < 0) return;
                skipped = 1;
            }
            count -= skipped;
        }
    }

    private static void copy(InputStream in, OutputStream out, long count) throws IOException {
        byte[] buffer = new byte[65536];
        while (count > 0) {
            int read = in.read(buffer, 0, (int) Math.min(buffer.length, count));
            if (read < 0) return;
            out.write(buffer, 0, read);
            count -= read;
        }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        byte[] buffer = new byte[65536];
        for (int read = in.read(buffer); read >= 0; read = in.read(buffer)) bytes.write(buffer, 0, read);
        return bytes.toByteArray();
    }
}
