#ifndef HPP_WEBSOCKET
#define HPP_WEBSOCKET

#include <string>
#include <vector>
#include <thread>
#include <atomic>
#include <mutex>

class WebSocketSubscriber {
public:
    static WebSocketSubscriber& getInstance();
    
    void setWssUrl(const std::string& url);
    void subscribeToAddress(const std::string& address);
    void start();
    void stop();

    // Made public for callback access
    std::vector<std::string> m_addresses;
    std::mutex m_mutex;

private:
    WebSocketSubscriber();
    ~WebSocketSubscriber();
    WebSocketSubscriber(const WebSocketSubscriber&) = delete;
    WebSocketSubscriber& operator=(const WebSocketSubscriber&) = delete;

    void runLoop();
    void processMessage(const std::string& message);
    
    std::string m_wssUrl;
    std::thread m_thread;
    std::atomic<bool> m_running;
};

#endif /* HPP_WEBSOCKET */
