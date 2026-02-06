#include "WebSocket.hpp"
#include "Telegram.hpp"
#include <iostream>
#include <cstring>
#include <libwebsockets.h>

static WebSocketSubscriber* g_instance = nullptr;
static std::string g_receivedData;
static struct lws* g_wsi = nullptr;

static int websocket_callback(struct lws* wsi, enum lws_callback_reasons reason,
                              void* user, void* in, size_t len) {
    switch (reason) {
        case LWS_CALLBACK_CLIENT_ESTABLISHED:
            std::cout << "WebSocket: Connected" << std::endl;
            lws_callback_on_writable(wsi);
            break;

        case LWS_CALLBACK_CLIENT_RECEIVE:
            if (in && len > 0) {
                g_receivedData.append((char*)in, len);
                if (lws_is_final_fragment(wsi)) {
                    if (g_instance) {
                        // Only forward subscription updates to Telegram, not initial subscription confirmations
                        // Subscription updates have "method":"eth_subscription"
                        // Subscription confirmations only have "result" with subscription ID
                        if (g_receivedData.find("\"method\":\"eth_subscription\"") != std::string::npos) {
                            Telegram::getInstance().sendMessage("WSS Update: " + g_receivedData);
                        }
                    }
                    g_receivedData.clear();
                }
            }
            break;

        case LWS_CALLBACK_CLIENT_WRITEABLE: {
            if (g_instance) {
                // Subscribe to pending addresses via eth_subscribe for pending transactions
                // or newHeads - implementation depends on the WSS endpoint capabilities
                std::lock_guard<std::mutex> lock(g_instance->m_mutex);
                for (const auto& addr : g_instance->m_addresses) {
                    std::string subMsg = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_subscribe\",\"params\":[\"logs\",{\"address\":\"" + addr + "\"}]}";
                    
                    std::vector<unsigned char> buf(LWS_PRE + subMsg.length());
                    memcpy(&buf[LWS_PRE], subMsg.c_str(), subMsg.length());
                    lws_write(wsi, &buf[LWS_PRE], subMsg.length(), LWS_WRITE_TEXT);
                    
                    std::cout << "WebSocket: Subscribed to " << addr << std::endl;
                }
                g_instance->m_addresses.clear();
            }
            break;
        }

        case LWS_CALLBACK_CLIENT_CONNECTION_ERROR:
            std::cerr << "WebSocket: Connection error" << std::endl;
            if (in) std::cerr << "  " << (char*)in << std::endl;
            break;

        case LWS_CALLBACK_CLIENT_CLOSED:
            std::cout << "WebSocket: Connection closed" << std::endl;
            g_wsi = nullptr;
            break;

        default:
            break;
    }
    return 0;
}

static const struct lws_protocols protocols[] = {
    { "wss-protocol", websocket_callback, 0, 65536 },
    { NULL, NULL, 0, 0 }
};

WebSocketSubscriber& WebSocketSubscriber::getInstance() {
    static WebSocketSubscriber instance;
    return instance;
}

WebSocketSubscriber::WebSocketSubscriber() : m_running(false) {
    g_instance = this;
}

WebSocketSubscriber::~WebSocketSubscriber() {
    stop();
    g_instance = nullptr;
}

void WebSocketSubscriber::setWssUrl(const std::string& url) {
    m_wssUrl = url;
}

void WebSocketSubscriber::subscribeToAddress(const std::string& address) {
    std::lock_guard<std::mutex> lock(m_mutex);
    m_addresses.push_back(address);
    
    // Request write callback if connected
    if (g_wsi) {
        lws_callback_on_writable(g_wsi);
    }
}

void WebSocketSubscriber::start() {
    if (m_running || m_wssUrl.empty()) return;
    
    m_running = true;
    m_thread = std::thread(&WebSocketSubscriber::runLoop, this);
}

void WebSocketSubscriber::stop() {
    m_running = false;
    if (m_thread.joinable()) {
        m_thread.join();
    }
}

void WebSocketSubscriber::runLoop() {
    struct lws_context_creation_info info;
    memset(&info, 0, sizeof(info));
    
    info.port = CONTEXT_PORT_NO_LISTEN;
    info.protocols = protocols;
    info.options = LWS_SERVER_OPTION_DO_SSL_GLOBAL_INIT;
    
    struct lws_context* context = lws_create_context(&info);
    if (!context) {
        std::cerr << "WebSocket: Failed to create context" << std::endl;
        return;
    }

    // Parse WSS URL
    std::string url = m_wssUrl;
    bool useSSL = (url.substr(0, 6) == "wss://");
    if (url.substr(0, 6) == "wss://") url = url.substr(6);
    else if (url.substr(0, 5) == "ws://") url = url.substr(5);
    
    std::string host = url;
    std::string path = "/";
    int port = useSSL ? 443 : 80;
    
    size_t pathPos = url.find('/');
    if (pathPos != std::string::npos) {
        host = url.substr(0, pathPos);
        path = url.substr(pathPos);
    }
    
    size_t portPos = host.find(':');
    if (portPos != std::string::npos) {
        port = std::stoi(host.substr(portPos + 1));
        host = host.substr(0, portPos);
    }

    struct lws_client_connect_info ccinfo;
    memset(&ccinfo, 0, sizeof(ccinfo));
    
    ccinfo.context = context;
    ccinfo.address = host.c_str();
    ccinfo.port = port;
    ccinfo.path = path.c_str();
    ccinfo.host = host.c_str();
    ccinfo.origin = host.c_str();
    ccinfo.protocol = protocols[0].name;
    ccinfo.ssl_connection = useSSL ? LCCSCF_USE_SSL : 0;

    g_wsi = lws_client_connect_via_info(&ccinfo);
    if (!g_wsi) {
        std::cerr << "WebSocket: Failed to connect" << std::endl;
        lws_context_destroy(context);
        return;
    }

    std::cout << "WebSocket: Connecting to " << m_wssUrl << std::endl;

    while (m_running) {
        lws_service(context, 100);
        
        // Reconnect if disconnected
        if (!g_wsi && m_running) {
            g_wsi = lws_client_connect_via_info(&ccinfo);
        }
    }

    lws_context_destroy(context);
}

void WebSocketSubscriber::processMessage(const std::string& message) {
    // Forward all messages to Telegram
    Telegram::getInstance().sendMessage("WSS: " + message);
}
