#include "Database.hpp"
#include <iostream>
#include <ctime>

Database& Database::getInstance() {
    static Database instance;
    return instance;
}

bool Database::init(const std::string& dbPath) {
    if (m_db != nullptr) {
        return true;
    }

    int rc = sqlite3_open(dbPath.c_str(), &m_db);
    if (rc != SQLITE_OK) {
        std::cerr << "Database: Failed to open database: " << sqlite3_errmsg(m_db) << std::endl;
        return false;
    }

    const char* createTableSQL = 
        "CREATE TABLE IF NOT EXISTS keypairs ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "private_key_offset TEXT NOT NULL,"
        "derived_address TEXT NOT NULL,"
        "contract_address TEXT,"
        "sender_address TEXT,"
        "transaction_hash TEXT,"
        "timestamp INTEGER NOT NULL"
        ");";

    char* errMsg = nullptr;
    rc = sqlite3_exec(m_db, createTableSQL, nullptr, nullptr, &errMsg);
    if (rc != SQLITE_OK) {
        std::cerr << "Database: Failed to create table: " << errMsg << std::endl;
        sqlite3_free(errMsg);
        return false;
    }

    return true;
}

bool Database::insertKeypair(
    const std::string& privateKeyOffset,
    const std::string& derivedAddress,
    const std::string& contractAddress,
    const std::string& senderAddress,
    const std::string& transactionHash
) {
    if (m_db == nullptr) {
        std::cerr << "Database: Not initialized" << std::endl;
        return false;
    }

    const char* insertSQL = 
        "INSERT INTO keypairs (private_key_offset, derived_address, contract_address, sender_address, transaction_hash, timestamp) "
        "VALUES (?, ?, ?, ?, ?, ?);";

    sqlite3_stmt* stmt;
    int rc = sqlite3_prepare_v2(m_db, insertSQL, -1, &stmt, nullptr);
    if (rc != SQLITE_OK) {
        std::cerr << "Database: Failed to prepare statement: " << sqlite3_errmsg(m_db) << std::endl;
        return false;
    }

    sqlite3_bind_text(stmt, 1, privateKeyOffset.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 2, derivedAddress.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 3, contractAddress.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 4, senderAddress.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 5, transactionHash.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int64(stmt, 6, static_cast<sqlite3_int64>(std::time(nullptr)));

    rc = sqlite3_step(stmt);
    sqlite3_finalize(stmt);

    if (rc != SQLITE_DONE) {
        std::cerr << "Database: Failed to insert: " << sqlite3_errmsg(m_db) << std::endl;
        return false;
    }

    return true;
}

void Database::close() {
    if (m_db != nullptr) {
        sqlite3_close(m_db);
        m_db = nullptr;
    }
}
