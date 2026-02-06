CC=g++
CDEFINES=
SOURCES=Dispatcher.cpp Mode.cpp precomp.cpp profanity.cpp SpeedSample.cpp Database.cpp Ethereum.cpp Telegram.cpp WebSocket.cpp
OBJECTS=$(SOURCES:.cpp=.o)
EXECUTABLE=profanity2.x64

UNAME_S := $(shell uname -s)
ifeq ($(UNAME_S),Darwin)
	LDFLAGS=-framework OpenCL -lsqlite3 -lcurl -lsecp256k1 -lwebsockets -lpthread
	CFLAGS=-c -std=c++11 -Wall -mmmx -O2
else
	LDFLAGS=-s -lOpenCL -mcmodel=large -lsqlite3 -lcurl -lsecp256k1 -lwebsockets -lpthread
	CFLAGS=-c -std=c++11 -Wall -mmmx -O2 -mcmodel=large 
endif

all: $(SOURCES) $(EXECUTABLE)

$(EXECUTABLE): $(OBJECTS)
	$(CC) $(OBJECTS) $(LDFLAGS) -o $@

.cpp.o:
	$(CC) $(CFLAGS) $(CDEFINES) $< -o $@

clean:
	rm -rf *.o

