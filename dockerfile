FROM mcr.microsoft.com/dotnet/sdk:7.0 AS build
WORKDIR /app

# Copy csproj and restore
COPY *.csproj ./
RUN dotnet restore

# Copy everything else and build
COPY . ./
RUN dotnet publish -c Release -o out

# Runtime stage
FROM mcr.microsoft.com/dotnet/aspnet:7.0
WORKDIR /app
COPY --from=build /app/out .
COPY --from=build /app/wwwroot ./wwwroot

# Railway sets PORT variable
ENV ASPNETCORE_URLS=http://+:${PORT:-3000}
EXPOSE ${PORT:-3000}

ENTRYPOINT ["dotnet", "MafiaGameBot.dll"]
