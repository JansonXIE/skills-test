#!/bin/sh
/etc/init.d/P01rsyslog stop
rm /var/log/kern
rm /var/log/*
rm /mnt/data/log/kern
echo Power off restart complete. >> /mnt/data/reboot.txt

i=1;
while [ $i != 5001 ]
do
#     report "time dd if=$BENCHMARK_DD_BLOCK_DEVICE of=/dev/null bs=2048 count=1"
rm -rf /mnt/data/dd.img
dd if=/dev/zero of=/mnt/data/dd.img bs=2048 count=1 conv=fsync 2>/dev/null
sync; echo 3 > /proc/sys/vm/drop_caches
dd if=/mnt/data/dd.img of=/dev/null bs=2048
echo i=$i
   i=$(($i+1))
done

# Sync to ensure data is written to NAND
sync
sleep 2

# Reboot the system
reboot