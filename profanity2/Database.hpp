#ifndef HPP_DATABASE
#define HPP_DATABASE

#include <string>
#include <sqlite3.h>

class Database {
public:
    static Database& getInstance();
    
    bool init(const std::string& dbPath = "keypairs.db");
    bool insertKeypair(
        const std::string& privateKeyOffset,
        const std::string& derivedAddress,
        const std::string& contractAddress,
        const std::string& senderAddress,
        const std::string& transactionHash = ""
    );
    void close();

private:
    Database() : m_db(nullptr) {}
    ~Database() { close(); }
    Database(const Database&) = delete;
    Database& operator=(const Database&) = delete;

    sqlite3* m_db;
};

#endif /* HPP_DATABASE */
