#include "Telegram.hpp"
#include <iostream>
#include <curl/curl.h>

Telegram& Telegram::getInstance() {
    static Telegram instance;
    return instance;
}

void Telegram::setBotToken(const std::string& token) {
    m_botToken = token;
}

void Telegram::setChatId(const std::string& chatId) {
    m_chatId = chatId;
}

static size_t WriteCallbackTg(void* contents, size_t size, size_t nmemb, void* userp) {
    ((std::string*)userp)->append((char*)contents, size * nmemb);
    return size * nmemb;
}

bool Telegram::sendMessage(const std::string& message) {
    if (m_botToken.empty() || m_chatId.empty()) {
        std::cerr << "Telegram: Bot token or chat ID not set" << std::endl;
        return false;
    }

    CURL* curl = curl_easy_init();
    if (!curl) return false;

    std::string response;
    std::string url = "https://api.telegram.org/bot" + m_botToken + "/sendMessage";
    
    // URL encode the message
    char* encodedMsg = curl_easy_escape(curl, message.c_str(), message.length());
    std::string postData = "chat_id=" + m_chatId + "&text=" + std::string(encodedMsg);
    curl_free(encodedMsg);

    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, postData.c_str());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, WriteCallbackTg);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 10L);

    CURLcode res = curl_easy_perform(curl);
    curl_easy_cleanup(curl);

    if (res != CURLE_OK) {
        std::cerr << "Telegram: Failed to send message: " << curl_easy_strerror(res) << std::endl;
        return false;
    }

    return response.find("\"ok\":true") != std::string::npos;
}
