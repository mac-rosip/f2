#ifndef HPP_TELEGRAM
#define HPP_TELEGRAM

#include <string>

class Telegram {
public:
    static Telegram& getInstance();
    
    void setBotToken(const std::string& token);
    void setChatId(const std::string& chatId);
    
    bool sendMessage(const std::string& message);

private:
    Telegram() = default;
    ~Telegram() = default;
    Telegram(const Telegram&) = delete;
    Telegram& operator=(const Telegram&) = delete;

    std::string m_botToken;
    std::string m_chatId;
};

#endif /* HPP_TELEGRAM */
